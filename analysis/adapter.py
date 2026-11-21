"""Build an AnalysisInput from the database, an importer result, a GAEB file or a JSON fixture.

The adapter normalizes (numbers, units, text, section tree) but never drops a line and never
repairs data. Anything it cannot read stays None with its raw value, so a rule can flag it.
"""

from __future__ import annotations

import copy
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
from pathlib import Path
import re
import sys
from typing import Any, Iterable
from uuid import NAMESPACE_URL, uuid5

from . import units
from .contracts import (
    AnalysisInput, Area, Bom, Distribution, ImportWarning, Line, PriceInfo, Project, ReferenceRange, Section,
    SourceAmounts, SourceDocument,
)

_CURRENCY_ALIASES = {"EURO": "EUR", "€": "EUR"}


# --------------------------------------------------------------------------- helpers


def to_decimal(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value if value.is_finite() else None
    try:
        number = Decimal(str(value).strip())
    except InvalidOperation:
        return None
    return number if number.is_finite() else None


def clean_short(text: str | None) -> str | None:
    if text is None:
        return None
    collapsed = " ".join(text.split())
    return collapsed or None


def clean_long(text: str | None) -> str | None:
    """Collapse spaces inside lines, drop empty lines, keep line breaks."""
    if text is None:
        return None
    lines = [" ".join(line.split()) for line in text.splitlines()]
    joined = "\n".join(line for line in lines if line)
    return joined or None


def currency_code(raw: str | None) -> str | None:
    if not raw:
        return None
    value = raw.strip().upper()
    value = _CURRENCY_ALIASES.get(value, value)
    return value if re.fullmatch(r"[A-Z]{3}", value) else None


def clean_flags(flags: dict | None) -> dict[str, str]:
    result = {}
    for key, value in (flags or {}).items():
        if value is None:
            continue
        text = str(value).strip()
        if text:
            result[key] = text
    return result


def derive_pricing(flags: dict[str, str]) -> tuple[str, str]:
    """(pricing_basis, total_rule) from GAEB XML and GAEB 90 flags.

    Mirrors importer/tender_import/draft.py so DB and file sources agree. GAEB 90:
    position_type N normal, G base (Grundposition), A alternative (Wahlposition);
    provisional_flag E = optional without total; extra_type_flag L = lump sum.
    A GAEB XML MarkupItem (surcharge) has a fixed amount and no quantity, so it is priced as a lump sum.
    """
    lump = flags.get("LumpSumItem") == "Yes" or flags.get("extra_type_flag") == "L" or flags.get("MarkupItem") == "Yes"
    pricing = "lump_sum" if lump else "unit_rate"
    if flags.get("Provis") == "WithoutTotal" or flags.get("provisional_flag") == "E":
        total_rule = "unit_price_only"
    elif flags.get("Provis") or flags.get("AltItem") or flags.get("position_type") == "A":
        total_rule = "conditional"
    else:
        total_rule = "include"
    return pricing, total_rule


def stable_id(*parts: Any) -> str:
    return str(uuid5(NAMESPACE_URL, "construct-analysis:" + "|".join(str(part) for part in parts)))


def finalize(analysis_input: AnalysisInput) -> AnalysisInput:
    return analysis_input.with_hash()


# --------------------------------------------------------------------------- JSON


def parse_number(value: Any) -> Decimal | None:
    """Lenient number parsing for hand-made JSON: 1234.5, "1.234,50", "1,234.50", "4,000"."""
    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip().replace(" ", "").replace(" ", "")
    if not text:
        return None
    if "," in text and "." in text:
        if text.rfind(",") > text.rfind("."):
            text = text.replace(".", "").replace(",", ".")
        else:
            text = text.replace(",", "")
    elif "," in text:
        text = text.replace(",", ".")
    return to_decimal(text)


def canonical_hash(analysis_input: AnalysisInput) -> str:
    return analysis_input.compute_hash()


def _flat_input(items: list, filename: str | None) -> dict:
    """The simple Item array: [{"oz", "short_text", "quantity", "unit", "trade_group", ...}]."""
    lines, sections = [], {}
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise ValueError(f"Item {index} must be a JSON object")
        line = copy.deepcopy(item)
        group = clean_short(line.pop("trade_group", None))
        if group:
            section_id = "trade_" + sha256(group.encode("utf-8")).hexdigest()[:16]
            sections.setdefault(section_id, {"id": section_id, "title": group, "sort_order": len(sections)})
            line.setdefault("section_id", section_id)
        code = line.pop("oz", None)
        line.setdefault("code", str(code) if code is not None else None)
        identity = json.dumps([line.get("code"), group, index], ensure_ascii=False)
        line.setdefault("id", "line_" + sha256(identity.encode("utf-8")).hexdigest()[:24])
        line.setdefault("sort_order", index)
        line.setdefault("source_locator", {"item_index": index, "filename": filename})
        lines.append(line)
    return {"project": {"source_document": {"filename": filename, "format": "json"}},
            "lines": lines, "sections": list(sections.values())}


def from_data(payload: dict | list, *, filename: str | None = None) -> AnalysisInput:
    """Build from parsed JSON: an AnalysisInput object, an Item array, or {"items": [...]}.

    Numbers may be German-formatted strings; unparseable numbers become None with an import warning.
    Units are normalized with the shared vocabulary. The payload is never modified.
    """
    if isinstance(payload, list):
        data = _flat_input(payload, filename)
    elif isinstance(payload, dict) and "items" in payload and "lines" not in payload:
        if not isinstance(payload["items"], list):
            raise ValueError("'items' must be an array")
        data = _flat_input(payload["items"], filename)
        for key in ("project", "bom", "areas", "import_warnings"):
            if key in payload:
                data[key] = copy.deepcopy(payload[key])
    elif isinstance(payload, dict) and isinstance(payload.get("lines"), list):
        data = copy.deepcopy(payload)
    else:
        raise ValueError("Expected an AnalysisInput object, an Item array, or {'items': [...]}")
    data.setdefault("import_warnings", [])
    if not isinstance(data["import_warnings"], list):
        raise ValueError("import_warnings must be an array")

    def numeric(container: dict, key: str, locator: dict) -> None:
        if key not in container:
            return
        raw = container[key]
        container[key] = parse_number(raw)
        if raw is not None and str(raw).strip() and container[key] is None:
            data["import_warnings"].append({"code": "INVALID_NUMBER", "message": f"Cannot parse {key}: {raw!r}",
                                            "locator": {**locator, "raw": str(raw)}})

    for index, line in enumerate(data["lines"]):
        if not isinstance(line, dict):
            raise ValueError(f"Line {index} must be a JSON object")
        line.setdefault("id", f"line_{index}")
        line.setdefault("sort_order", index)
        line.setdefault("code_parts", str(line["code"]).split(".") if line.get("code") else [])
        line.setdefault("quantity_raw", str(line["quantity"]) if line.get("quantity") is not None else None)
        line.setdefault("unit_raw", line.get("unit"))
        unit = line.get("unit")
        if unit is not None and not isinstance(unit, str):
            raise ValueError(f"Line {index}: unit must be text or null")
        line["unit"] = units.normalize(unit)
        line["short_text"] = clean_short(line.get("short_text"))
        line["long_text"] = clean_long(line.get("long_text"))
        locator = line.get("source_locator", {"line_id": line["id"]})
        numeric(line, "quantity", locator)
        distributions = line.get("distributions", [])
        if not isinstance(distributions, list) or any(not isinstance(d, dict) for d in distributions):
            raise ValueError(f"Line {index}: distributions must be an array of objects")
        for distribution in distributions:
            numeric(distribution, "quantity", {**locator, "area_id": distribution.get("area_id")})
        for field in ("source_amounts", "price"):
            if line.get(field) is not None:
                if not isinstance(line[field], dict):
                    raise ValueError(f"Line {index}: {field} must be an object or null")
                numeric(line[field], "unit_price", locator)
                numeric(line[field], "line_amount", locator)
        if line.get("price"):
            price = line["price"]
            price["price_unit"] = units.normalize(price.get("price_unit"))
            if price.get("reference_range"):
                if not isinstance(price["reference_range"], dict):
                    raise ValueError(f"Line {index}: reference_range must be an object or null")
                for field in ("min", "median", "max"):
                    numeric(price["reference_range"], field, locator)
    for index, section in enumerate(data.get("sections", [])):
        section.setdefault("sort_order", index)
    for area in data.get("areas", []):
        area.setdefault("name", area.get("id", ""))
    analysis_input = AnalysisInput.model_validate(data)
    for collection in (analysis_input.lines, analysis_input.sections, analysis_input.areas):
        ids = [item.id for item in collection]
        if len(ids) != len(set(ids)):
            raise ValueError("Internal IDs must be unique within each collection")
    return finalize(analysis_input)


def from_json(path: str | Path) -> AnalysisInput:
    """Read an AnalysisInput JSON file, an Item array, or {"items": [...]} (see from_data)."""
    path = Path(path)
    with path.open(encoding="utf-8-sig") as handle:
        payload = json.load(handle, parse_float=Decimal)
    return from_data(payload, filename=path.name)


def to_json(analysis_input: AnalysisInput, path: str | Path) -> None:
    Path(path).write_text(analysis_input.model_dump_json(indent=2), encoding="utf-8")


# --------------------------------------------------------------------------- importer result / file


def _importer_on_path() -> None:
    try:
        import tender_import  # noqa: F401
    except ImportError:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "importer"))


def from_file(path: str | Path, *, boq_index: int | None = None, legacy_encoding: str | None = None) -> AnalysisInput:
    """Parse a GAEB XML (X8x) or GAEB 90 (D8x) file directly, without the database."""
    _importer_on_path()
    from tender_import.common import detect_format
    from tender_import.legacy import gaeb_1990
    from tender_import.structured import gaeb_xml

    path = Path(path)
    data = path.read_bytes()
    document_format = detect_format(path.name, data)
    if document_format == "gaeb_xml":
        result = gaeb_xml(data)
    elif document_format == "gaeb_1990":
        result = gaeb_1990(data, encoding_override=legacy_encoding)
    else:
        raise ValueError(f"from_file supports GAEB XML and GAEB 90, got {document_format!r}")
    document = SourceDocument(id=sha256(data).hexdigest(), filename=path.name, format=document_format)
    return from_import(result, document=document, boq_index=boq_index)


def from_import(result: Any, *, document: SourceDocument | None = None, boq_index: int | None = None) -> AnalysisInput:
    """Build from a tender_import Result (records with kind/locator/payload)."""
    document = document or SourceDocument(format=getattr(result, "format", None))
    doc_key = document.id or document.filename or "document"
    records = list(result.records)

    boq_indexes = sorted({r.payload.get("boq_index") for r in records if r.kind == "boq_header"})
    if boq_index is None and len(boq_indexes) > 1:
        raise ValueError(f"The file has several BoQs. Choose boq_index from {boq_indexes}")
    if boq_index is not None:
        records = [r for r in records if r.payload.get("boq_index", boq_index) == boq_index]
    boq_title = next((r.payload.get("boq_title") for r in records if r.kind == "boq_header"), None)
    metadata = getattr(result, "metadata", {}) or {}

    sections, section_keys = _sections_from_records(records, doc_key)
    lines = _lines_from_records(records, doc_key, sections, section_keys)

    subtotals = {tuple(r.payload.get("code_parts") or ()): r.payload for r in records if r.kind == "subtotal"}
    for section in sections:
        subtotal = subtotals.get(tuple(section.code_parts), {})
        section.stated_total = to_decimal(subtotal.get("reported_amount"))
        section.stated_total_after_discount = to_decimal(subtotal.get("discounted_amount"))
        section.stated_lump_sum_total = to_decimal(subtotal.get("lump_sum_amount"))
    summary = next((r.payload for r in records if r.kind == "summary"), {})

    analysis_input = AnalysisInput(
        project=Project(
            name=metadata.get("project_label") or metadata.get("title"),
            currency=currency_code(metadata.get("currency")),
            gaeb_phase=getattr(result, "phase", None),
            source_document=document,
        ),
        bom=Bom(title=boq_title or metadata.get("title") or document.filename,
                stated_net_total=to_decimal(summary.get("net_total"))),
        sections=sections,
        lines=lines,
        import_warnings=[ImportWarning(code=i["code"], message=i.get("detail"), locator=i.get("locator") or {})
                         for i in getattr(result, "issues", [])],
    )
    return finalize(analysis_input)


def _sections_from_records(records, doc_key) -> tuple[list[Section], dict]:
    sections: list[Section] = []
    keys: dict = {}  # xml_path or tuple(code_parts) -> section id
    for ordinal, record in enumerate(records):
        if record.kind not in {"section", "section_candidate"}:
            continue
        payload, locator = record.payload, record.locator
        parts = [str(part) for part in payload.get("code_parts") or []] or _code_parts(payload.get("code"))
        section_id = stable_id(doc_key, "section", locator.get("xml_path") or locator.get("record") or ordinal)
        parent = keys.get(payload.get("parent_section")) or (keys.get(tuple(parts[:-1])) if len(parts) > 1 else None)
        sections.append(Section(
            id=section_id, parent_id=parent, code=payload.get("code") or ".".join(parts) or None,
            code_parts=parts, title=clean_short(payload.get("label")), sort_order=ordinal,
        ))
        if locator.get("xml_path"):
            keys[locator["xml_path"]] = section_id
        if parts:
            keys[tuple(parts)] = section_id
        if payload.get("code"):
            keys[str(payload["code"])] = section_id  # PDF items name their section by its printed code
    return sections, keys


def _code_parts(code) -> list[str]:
    """'10.2.30.' -> ['10', '2', '30'] for sources (PDF, Word) that print the OZ but don't split it."""
    return [part for part in str(code or "").strip().split(".") if part] if code else []


def _lines_from_records(records, doc_key, sections, section_keys) -> list[Line]:
    lines: list[Line] = []
    last_base_by_section: dict = {}
    for ordinal, record in enumerate(records):
        if record.kind not in {"item", "item_candidate"}:
            continue
        payload, locator = record.payload, record.locator
        parts = [str(part) for part in payload.get("code_parts") or []] or _code_parts(payload.get("code"))
        section_ref = payload.get("section_path")
        if isinstance(section_ref, list):
            section_ref = section_ref[-1] if section_ref else None
        section_id = section_keys.get(section_ref) if section_ref else None
        if section_id is None and len(parts) > 1:
            section_id = section_keys.get(tuple(parts[:-1]))

        flags = clean_flags(payload.get("flags"))
        pricing_basis, total_rule = derive_pricing(flags)
        unit_raw = payload.get("unit")
        quantity_raw = payload.get("quantity_raw", payload.get("quantity"))

        line_id = stable_id(doc_key, "line", locator.get("xml_path") or locator.get("record") or ordinal)
        alternative_for = None
        position_type = flags.get("position_type")
        if position_type == "G":
            last_base_by_section[section_id] = line_id
        elif position_type == "A":
            alternative_for = last_base_by_section.get(section_id)

        lines.append(Line(
            id=line_id,
            code=payload.get("code"),
            code_parts=parts,
            section_id=section_id,
            sort_order=ordinal,
            short_text=clean_short(payload.get("short_description")),
            long_text=clean_long(payload.get("long_description")),
            quantity=to_decimal(payload.get("quantity")),
            quantity_raw=str(quantity_raw) if quantity_raw is not None else None,
            unit=units.normalize(unit_raw),
            unit_raw=unit_raw,
            pricing_basis=pricing_basis,
            total_rule=total_rule,
            alternative_for=alternative_for,
            gaeb_flags=flags,
            source_amounts=_source_amounts(payload),
            source_locator={"ordinal": ordinal, **locator},
        ))
    return lines


def _source_amounts(payload: dict) -> SourceAmounts | None:
    unit_price, line_amount = payload.get("unit_price"), payload.get("line_amount")
    price_records = payload.get("price_records") or []
    if unit_price is None and line_amount is None and price_records:
        unit_price, line_amount = price_records[0].get("unit_price"), price_records[0].get("line_amount")
    if unit_price is None and line_amount is None:
        return None
    return SourceAmounts(unit_price=to_decimal(unit_price), line_amount=to_decimal(line_amount))


# --------------------------------------------------------------------------- database


def from_db(connection, bom_version_id: str) -> AnalysisInput:
    """Build from a stored BOM. `connection` is a psycopg 3 connection."""
    header = connection.execute(
        """
        SELECT v.id, v.package_code, v.title, p.id, p.name,
               COALESCE(to_jsonb(v)->>'draft_currency', p.default_currency::text),
               d.id, d.filename, d.format, d.exchange_phase
        FROM bom_version v
        JOIN project p ON p.id = v.project_id
        LEFT JOIN bom_source s ON s.bom_version_id = v.id AND s.role = 'primary_scope'
        LEFT JOIN source_document d ON d.id = s.source_document_id
        WHERE v.id = %s
        """, (bom_version_id,),
    ).fetchone()
    if header is None:
        raise ValueError(f"BOM version {bom_version_id} not found")
    (version_id, package_code, title, project_id, project_name, currency,
     document_id, filename, document_format, phase) = header

    sections = [
        Section(id=str(row[0]), parent_id=_str(row[1]), code=row[2], code_parts=(row[2] or "").split(".") if row[2] else [],
                title=row[3], sort_order=row[4])
        for row in connection.execute(
            """SELECT id, parent_section_id, display_code, title, sort_order
               FROM bom_section WHERE bom_version_id = %s ORDER BY sort_order""", (version_id,),
        )
    ]

    area_rows = connection.execute(
        """
        SELECT DISTINCT a.id, a.parent_area_id, a.name, a.kind
        FROM project_area a WHERE a.project_id = %s ORDER BY a.name
        """, (project_id,),
    ).fetchall()
    areas = [Area(id=str(r[0]), parent_id=_str(r[1]), name=r[2], kind=r[3] or "unknown") for r in area_rows]

    distributions: dict[str, list[Distribution]] = {}
    for line_id, area_id, quantity in connection.execute(
        """SELECT d.bom_line_id, d.area_id, d.quantity FROM bom_line_distribution d
           JOIN bom_line l ON l.id = d.bom_line_id WHERE l.bom_version_id = %s""", (version_id,),
    ):
        distributions.setdefault(str(line_id), []).append(Distribution(area_id=str(area_id), quantity=quantity))

    prices = _load_prices(connection, version_id)
    source_rows = _load_source_payloads(connection, version_id)

    lines = []
    for row in connection.execute(
        """
        SELECT id, section_id, line_code, sort_order, short_description, long_description, quantity,
               raw_unit, unit_code, pricing_basis, total_rule, alternative_for_line_id, source_locator,
               (to_jsonb(l)->>'draft_unit_price')::numeric
        FROM bom_line l WHERE bom_version_id = %s ORDER BY sort_order, id
        """, (version_id,),
    ):
        (line_id, section_id, code, sort_order, short, long, quantity, raw_unit, unit_code, pricing_basis,
         total_rule, alternative_for, locator, draft_price) = row
        line_id = str(line_id)
        source = source_rows.get(line_id, {})
        unit_raw = raw_unit if raw_unit is not None else unit_code
        normalized_unit = units.normalize(unit_code) or units.normalize(unit_raw)
        price = prices.get(line_id)
        if price is None and draft_price is not None:
            price = PriceInfo(unit_price=draft_price, currency=currency, price_unit=normalized_unit, source="client")
        lines.append(Line(
            id=line_id, code=code, code_parts=code.split(".") if code else [], section_id=_str(section_id),
            sort_order=sort_order, short_text=clean_short(short), long_text=clean_long(long),
            quantity=quantity, quantity_raw=_raw_quantity(source, quantity),
            unit=normalized_unit, unit_raw=unit_raw,
            pricing_basis=pricing_basis, total_rule=total_rule, alternative_for=_str(alternative_for),
            gaeb_flags=clean_flags(source.get("flags")), source_amounts=_source_amounts(source),
            price=price, distributions=distributions.get(line_id, []),
            source_locator=locator or {},
        ))

    analysis_input = AnalysisInput(
        project=Project(
            id=str(project_id), name=project_name, currency=currency, gaeb_phase=phase,
            source_document=SourceDocument(id=_str(document_id), filename=filename, format=document_format),
        ),
        bom=Bom(bom_version_id=str(version_id), package_code=package_code, title=title),
        areas=areas, sections=sections, lines=lines,
        import_warnings=_load_import_warnings(connection, document_id) if document_id else [],
    )
    return finalize(analysis_input)


def _str(value) -> str | None:
    return str(value) if value is not None else None


def _raw_quantity(source: dict, quantity) -> str | None:
    raw = source.get("quantity_raw", source.get("quantity"))
    if raw is not None:
        return str(raw)
    return str(quantity) if quantity is not None else None


def _load_source_payloads(connection, version_id) -> dict[str, dict]:
    """The original extract payload per line (flags, raw quantity, bid prices) via source_locator."""
    rows = connection.execute(
        """
        SELECT l.id, e.payload
        FROM bom_line l
        JOIN source_extract e ON e.import_id = (l.source_locator ->> 'import_id')::uuid
                             AND e.ordinal = (l.source_locator ->> 'ordinal')::integer
        WHERE l.bom_version_id = %s AND l.source_locator ? 'import_id'
        """, (version_id,),
    ).fetchall()
    return {str(line_id): payload or {} for line_id, payload in rows}


def _load_prices(connection, version_id) -> dict[str, PriceInfo]:
    exists = connection.execute("SELECT to_regclass('public.line_pricing') IS NOT NULL").fetchone()[0]
    if not exists:
        return {}
    prices = {}
    for row in connection.execute(
        """
        SELECT p.bom_line_id, p.unit_price, p.currency, p.price_unit, p.line_amount, p.source, p.source_ref,
               p.matched_text, p.match_confidence, p.price_date, p.reference_min, p.reference_median,
               p.reference_max, p.reference_count, p.citations
        FROM line_pricing p JOIN bom_line l ON l.id = p.bom_line_id
        WHERE l.bom_version_id = %s AND p.is_current
        """, (version_id,),
    ):
        (line_id, unit_price, currency, price_unit, line_amount, source, source_ref, matched_text, confidence,
         price_date, ref_min, ref_median, ref_max, ref_count, citations) = row
        reference = None
        if ref_count and None not in (ref_min, ref_median, ref_max):
            reference = ReferenceRange(min=ref_min, median=ref_median, max=ref_max, n=ref_count)
        prices[str(line_id)] = PriceInfo(
            unit_price=unit_price, currency=currency, price_unit=units.normalize(price_unit), line_amount=line_amount,
            source=source, source_ref=source_ref, matched_text=matched_text,
            match_confidence=float(confidence) if confidence is not None else None, price_date=price_date,
            reference_range=reference, citations=list(citations or []),
        )
    return prices


def _load_import_warnings(connection, document_id) -> list[ImportWarning]:
    row = connection.execute(
        """SELECT metadata -> 'issues' FROM source_import WHERE source_document_id = %s
           ORDER BY imported_at DESC, id DESC LIMIT 1""", (document_id,),
    ).fetchone()
    issues: Iterable[dict] = (row[0] if row and isinstance(row[0], list) else [])
    return [ImportWarning(code=i.get("code", "unknown"), message=i.get("detail"), locator=i.get("locator") or {})
            for i in issues]
