"""Precast extraction (spec Step 2) and the checks that run on the extracted fields.

`extracted(ctx)` processes each selected precast section in batches. It validates the extraction
response and shares it with the scope audit. Ollama uses a smaller classification request and reads
explicit values from the source. Its rebar batches require evidence for any assigned purpose.
The checks on top are deterministic Python:

- L3.PRECAST.MISSING_SPEC (spec DEP_001 / DEP_002): a sandwich element without height, length, concrete
  grade or total thickness, or through-coloured concrete without a RAL colour / pigment.
- L3.OPT.BUNDLED_FORMWORK (spec LLM_OPT_01, info): several elements share one cross-section, so formwork
  and pigment costs can be reviewed over the bundled length.

Anti-hallucination: a value the model "extracts" must be backed by the text. Grade, colour and element mark
must be written there. Supported dimension values are read from the labelled measurement and normalized
to the target unit. "Through-coloured" needs the word.
"""

from __future__ import annotations

from decimal import Decimal
import re
from typing import Any

from ...contracts import Line
from ...layer1.precast import LAYERS, item_type as source_item_type
from ...layer1.textvalues import DIMENSIONS, EXPOSURE, MEASURE, centimetres, grades
from ...registry import rule
from .. import prompts
from ..common import DEFAULT_LOCAL_MAX_BATCH_LINES, batches, clip, current
from ..provider import LLMRequest, OllamaProvider
from ..schema import ITEM_TYPES, PRECAST_SCHEMA, REBAR_PURPOSES, PrecastItem, items, quote_in, value_in

MISSING_SPEC = "L3.PRECAST.MISSING_SPEC"
BUNDLED = "L3.OPT.BUNDLED_FORMWORK"
EXTRACTION = "L3.PRECAST.EXTRACTION"  # budget/error label for the extraction calls (not a rule)
MEMO_KEY = "precast_items"

PRECAST_ELEMENT = re.compile(r"fertigteil|\bft-|sandwich", re.IGNORECASE)
_HEIGHT = (
    re.compile(rf"\b(?:h\s*=|H(?:ö|oe)he\s*[:=]?)\s*(?:ca\.?\s*)?{MEASURE}", re.I),
    re.compile(rf"{MEASURE}\s+hoch\b", re.I),
)
_LENGTH = (DIMENSIONS["length"], re.compile(rf"{MEASURE}\s+lang\b", re.I))
_THICKNESS = (
    LAYERS["total_thickness_cm"],
    re.compile(rf"\bGesamtdicke\s*[:=]?\s*(?:ca\.?\s*)?{MEASURE}", re.I),
)
_COLOURED = re.compile(r"durchgef(ä|ae)rbt|eingef(ä|ae)rbt|farbbeton", re.IGNORECASE)
_COMPACT_VERSION = "l3-precast-local-v1"
_REBAR_VERSION = "l3-precast-local-rebar-v1"
_COMPACT_SYSTEM = """Classify each German construction bill item using its ref.
FT-Sockel and Sandwichelement are sandwich_plinth. Other supplied precast elements are precast_element.
Betonstahl is rebar. Classify only what the item supplies. Drawings, opening surcharges and separate
embedded parts have their own types. Transport and joint sealing alone are other.
For rebar, use site_connection for Ortbetonanschlüsse or site connection steel, factory_reinforcement
for factory reinforcement supplied here, both if both are supplied here, or unspecified if the item
does not assign the steel. Reinforcement included in another position does not count. For other types
use not_applicable. Copy an explicit color or pigment for colored concrete, or use null.
Return exactly one item for each ref."""
_ELEMENT_MARK = re.compile(r"^\s*(FS\s*\d+)\s*:", re.I)
_RAL = re.compile(r"\bRAL\s*(\d{4})\b", re.I)
_COLOUR_ASSIGNMENT = re.compile(
    r"\b(?:Farbton|Farbnummer|Farbbezeichnung|Betonfarbe|Pigment(?:ierung)?)\b"
    r"|\b(?:durchgef[äa]rbt|eingef[äa]rbt)\w*\s+(?:in|mit Pigment)\b", re.I,
)

_REBAR_SYSTEM = """Read each German rebar position independently and copy its ref.
The type is always rebar. Assign site_connection only when THIS position supplies reinforcement for
connections made on site. Assign factory_reinforcement only when THIS position supplies reinforcement
inside factory-made precast elements. Use both only when this item supplies both. References to work
included elsewhere do not assign this item. If the text just supplies or installs steel without naming
its purpose, use unspecified. Copy a short verbatim phrase that establishes the assigned purpose as
rebar_scope_quote, or use null when unspecified. Return exactly one item for each ref."""
_REBAR_TITLE = re.compile(r"^\s*(?:Stabstahl|Bewehrungsstahl|Bewehrungsmatten)\b", re.I)
_REBAR_SITE = re.compile(r"\bfür\s+(?:die\s+)?(?:Ortbetonanschl[üu]ss\w*|Anschlussbewehrung)\b", re.I)
_REBAR_FACTORY = re.compile(r"\bals\s+werkseitige\s+Bewehrung\b", re.I)
_SITE_QUOTE = re.compile(r"\b(?:Ortbetonanschl\w*|Anschlussbewehrung|Ortbetonergänzung|Vergussbewehrung)\b", re.I)
_FACTORY_QUOTE = re.compile(r"\b(?:werkseitig\w*|Fertigteilbewehrung|im Werk|im Fertigteil)\b", re.I)
_ELSEWHERE = re.compile(r"\b(?:bauseits|nicht|enthalten in|in den Fertigteilpositionen enthalten)\b", re.I)

_NEGATED_COLOUR = re.compile(r"\b(?:nicht|ohne)\s+[^.\n]{0,25}(?:durchgef[äa]rbt|eingef[äa]rbt|farbbeton)", re.I)
_ANCHOR_DESIGN = re.compile(r"\b(?:Planung|Bemessung)\s+der\s+(?:Sandwichplattenanker|Transportanker)\b", re.I)
_SURFACES = {side: re.compile(rf"\b{side}\s*:\s*(?:Sichtbeton\s+)?(SB[1-4])\b", re.I)
             for side in ("innen", "außen")}
_ASSIGNED_ELEMENTS = re.compile(r"\b(?:für|zugeordnet zu)\s+(?:das Element\s+)?(FS\s*\d+)\b", re.I)


# DEP_001 required fields, in question order, with the German wording for the Bieterfrage.
REQUIRED_FIELDS: dict[str, str] = {
    "height_m": "die Elementhöhe",
    "length_m": "die Elementlänge",
    "concrete_grade": "die Betonfestigkeitsklasse",
    "layers.total_thickness_cm": "die Gesamtdicke des Elements",
}
COLOUR_FIELD = "color_pigment_ral"
COLOUR_TEXT = "den RAL-Farbton bzw. das Pigment für den durchgefärbten Beton"
FIELD_LABELS = {"height_m": "height", "length_m": "length", "concrete_grade": "concrete grade",
                "layers.total_thickness_cm": "total thickness", COLOUR_FIELD: "RAL colour / pigment"}


def precast_groups(lines: list[Line], section_titles: dict[str | None, str]) -> list[list[Line]]:
    """Lines of each section that contains a precast element, in document order."""
    by_section: dict[str | None, list[Line]] = {}
    for line in sorted(lines, key=lambda l: l.sort_order):
        by_section.setdefault(line.section_id, []).append(line)
    groups = []
    for section_id, section_lines in by_section.items():
        title = section_titles.get(section_id) or ""
        if PRECAST_ELEMENT.search(title) or any(PRECAST_ELEMENT.search(line.short_text or "")
                                                for line in section_lines):
            groups.append(section_lines)
    return groups


def extracted(ctx) -> list[tuple[Line, dict[str, Any]]]:
    """(line, extracted fields) for every precast-section line the model answered for. Memoized per run."""
    session = current()
    if MEMO_KEY in session.memo:
        return session.memo[MEMO_KEY]
    titles = {section.id: section.title or "" for section in ctx.input.sections}
    compact = isinstance(session.provider, OllamaProvider)
    max_lines = min(session.max_batch_lines, DEFAULT_LOCAL_MAX_BATCH_LINES) if compact else session.max_batch_lines
    chunks: list[tuple[list[Line], bool]] = []
    for group in precast_groups(ctx.input.lines, titles):
        rebar_ids = {line.id for line in group if _source_kind(line.short_text or "") == "rebar"} if compact else set()
        for rebar in (False, True):
            sized = [(line, len(line.short_text or "") + min(len(line.long_text or ""), 3_000) + 80) for line in group
                     if (line.id in rebar_ids) == rebar]
            chunks.extend((chunk, rebar) for chunk in batches(sized, session.max_batch_chars, max_lines))
    requests = []
    for chunk, rebar in chunks:
        payload = [{"ref": f"#{index}", "code": line.code, "short_text": line.short_text,
                    "long_text": clip(line.long_text), "quantity": _plain(line.quantity),
                    "unit": line.unit_raw or line.unit}
                   for index, line in enumerate(chunk, start=1)]
        if compact:
            requests.append(_compact_request(payload, rebar=rebar))
        else:
            requests.append(LLMRequest(system=prompts.PRECAST_SYSTEM, prompt=prompts.precast_prompt(payload),
                                       schema=PRECAST_SCHEMA, prompt_version=prompts.PRECAST_VERSION))
    result: list[tuple[Line, dict[str, Any]]] = []
    for (chunk, _), answer in zip(chunks, session.ask_many(EXTRACTION, requests)):
        if answer is None:
            continue
        answers, dropped = items(answer, "items", PrecastItem)
        session.dropped[EXTRACTION] += dropped
        refs = {f"#{index}": line for index, line in enumerate(chunk, start=1)}
        seen: set[str] = set()
        for item in answers:
            line = refs.get(item.line_ref.strip())
            if line is None or line.id in seen:
                session.dropped[EXTRACTION] += 1
                continue
            seen.add(line.id)
            result.append((line, verified(line, item, compact=compact)))
        unchecked = [line.code or line.id for line in chunk if line.id not in seen]
        if unchecked:
            session.errors.append(f"{EXTRACTION}: no valid extraction for {', '.join(unchecked)}")
    result.sort(key=lambda pair: pair[0].sort_order)
    session.memo[MEMO_KEY] = result
    return result


def _compact_request(payload: list[dict], *, rebar: bool) -> LLMRequest:
    refs = [item["ref"] for item in payload]
    properties = {
        "line_ref": {"type": "string", "enum": refs},
        "item_type": {"type": "string", "enum": list(ITEM_TYPES)},
        "rebar_purpose": {"type": "string", "enum": list(REBAR_PURPOSES)},
        COLOUR_FIELD: {"type": ["string", "null"]},
    }
    if rebar:
        properties["item_type"]["enum"] = ["rebar"]
        properties["rebar_purpose"]["enum"] = [purpose for purpose in REBAR_PURPOSES if purpose != "not_applicable"]
        properties["rebar_scope_quote"] = properties.pop(COLOUR_FIELD)
    schema = {"type": "object", "additionalProperties": False, "required": ["items"],
              "properties": {"items": {"type": "array", "minItems": len(refs), "maxItems": len(refs),
                                       "items": {"type": "object", "additionalProperties": False,
                                                 "required": list(properties), "properties": properties}}}}
    return LLMRequest(_REBAR_SYSTEM if rebar else _COMPACT_SYSTEM, prompts.precast_prompt(payload), schema,
                      _REBAR_VERSION if rebar else _COMPACT_VERSION)


def _version(provider) -> str:
    return _COMPACT_VERSION if isinstance(provider, OllamaProvider) else prompts.PRECAST_VERSION


def _only(values: set[str]) -> str | None:
    return next(iter(values)) if len(values) == 1 else None


def _source_kind(short: str) -> str | None:
    candidate = source_item_type(short)
    return candidate[0] if candidate else "rebar" if _REBAR_TITLE.match(short) else None


def _add_source_values(data: dict, short: str, text: str, rebar_quote: str | None) -> None:
    data["item_type"] = _source_kind(short) or data["item_type"]
    clauses = [clause for clause in re.split(r"(?<=[.!?])\s+|\n", text) if not _ELSEWHERE.search(clause)]
    if data["item_type"] == "rebar":
        quote = rebar_quote or ""
        grounded = any(quote_in(quote, clause) for clause in clauses)
        site = any(_REBAR_SITE.search(clause) for clause in clauses) or grounded and _SITE_QUOTE.search(quote)
        factory = any(_REBAR_FACTORY.search(clause) for clause in clauses) or grounded and _FACTORY_QUOTE.search(quote)
        data["rebar_purpose"] = ("both" if site and factory else "site_connection" if site else
                                 "factory_reinforcement" if factory else "unspecified")
    else:
        data["rebar_purpose"] = "not_applicable"
    if data["item_type"] == "embedded_part":
        data["assigned_element_codes"] = list(dict.fromkeys(mark for clause in clauses for mark in _ASSIGNED_ELEMENTS.findall(clause)))
    if data["item_type"] in {"sandwich_plinth", "precast_element"}:
        mark = _ELEMENT_MARK.match(short)
        ral = _only(set(_RAL.findall(text)))
        data.update(
            element_code=mark[1] if mark else None,
            concrete_grade=_only(grades(text)),
            exposure_classes=sorted(set(EXPOSURE.findall(text))),
            is_through_colored=bool(_COLOURED.search(text)) and not _NEGATED_COLOUR.search(text),
            includes_anchor_engineering=any(_ANCHOR_DESIGN.search(clause) for clause in clauses),
            layers={key: _measurement(text, (pattern,)) for key, pattern in LAYERS.items()},
        )
        for side, field in (("innen", "surface_inside"), ("außen", "surface_outside")):
            data[field] = _only({value.upper() for value in _SURFACES[side].findall(text)})
        pigment = data[COLOUR_FIELD]
        if ral is not None:
            data[COLOUR_FIELD] = f"RAL {ral}"
        elif pigment and not any(_COLOUR_ASSIGNMENT.search(clause) and quote_in(pigment, clause)
                                 for clause in clauses):
            data[COLOUR_FIELD] = None


def verified(line: Line, item: PrecastItem, *, compact: bool = False) -> dict[str, Any]:
    """The extracted fields as a plain dict, with values the text does not back set to None/False."""
    text = _text(line)
    data = item.model_dump(exclude={"line_ref", "rebar_scope_quote"})
    data["oz"] = line.code
    data["quantity"] = _plain(line.quantity)
    data["unit"] = line.unit_raw or line.unit
    if compact:
        _add_source_values(data, line.short_text or "", text, item.rebar_scope_quote)
    if data["concrete_grade"]:
        data["concrete_grade"] = re.sub(r"\s+", "", data["concrete_grade"]).upper()
    for key in ("concrete_grade", "color_pigment_ral", "element_code"):
        if data[key] and not value_in(data[key], line.short_text, line.long_text):
            data[key] = None
    if data["item_type"] in {"sandwich_plinth", "precast_element"}:
        data["height_m"] = _measurement(text, _HEIGHT, scale=100)
        data["length_m"] = _measurement(text, _LENGTH, scale=100)
        total = _measurement(text, _THICKNESS)
        if data["layers"] is not None or total is not None:
            data["layers"] = {**(data["layers"] or {}), "total_thickness_cm": total}
    if data["is_through_colored"] and not _COLOURED.search(text):
        data["is_through_colored"] = False
    return data


def _measurement(text: str, patterns: tuple[re.Pattern, ...], *, scale: int = 1) -> float | None:
    values = {centimetres(*(part for part in match.groups() if part is not None))
              for pattern in patterns for match in pattern.finditer(text)}
    return float(values.pop() / scale) if len(values) == 1 else None


def missing_fields(data: dict[str, Any]) -> list[str]:
    """Spec DEP_001 (sandwich elements) and DEP_002 (through-coloured concrete needs a colour)."""
    missing = []
    if data["item_type"] == "sandwich_plinth":
        missing = [name for name in REQUIRED_FIELDS if _get(data, name) is None]
    if data["item_type"] in ("sandwich_plinth", "precast_element") and data["is_through_colored"] \
            and not data[COLOUR_FIELD]:
        missing.append(COLOUR_FIELD)
    return missing


@rule(MISSING_SPEC, layer=3, category="completeness", severity="warning", title="Precast element spec incomplete",
      description="A sandwich element without height, length, concrete grade or total thickness, or "
                  "through-coloured concrete without RAL colour/pigment (spec DEP_001/DEP_002). Fields are "
                  "extracted by the model and checked against the text; the rule itself is deterministic.")
def missing_spec(ctx):
    session = current()
    for line, data in extracted(ctx):
        missing = missing_fields(data)
        if not missing:
            continue
        wanted = [REQUIRED_FIELDS.get(name, COLOUR_TEXT) for name in missing]
        element = f" ({data['element_code']})" if data.get("element_code") else ""
        question = (f"Zu Pos. {line.code}{element}: Bitte teilen Sie uns {_join_de(wanted)} mit. "
                    "Die Angabe ist in der Leistungsbeschreibung nicht eindeutig belegt.")
        labels = ", ".join(FIELD_LABELS[name] for name in missing)
        yield ctx.finding(
            line=line, discriminator=",".join(missing), origin="llm", model=session.model_id,
            message=f"{line.code}: the precast element description does not establish the {labels}.",
            evidence={"missing_fields": missing, "spec_checks": _checks(missing), "extracted": data,
                      "bieterfrage_de": question, "prompt_version": _version(session.provider)},
        )


@rule(BUNDLED, layer=3, category="optimization", severity="info", title="Precast elements with matching dimensions",
      description="Several precast elements share stated height, thickness, concrete grade and surfaces (spec LLM_OPT_01): "
                  "formwork and pigment can be calculated over the bundled length. Computed from the "
                  "extracted fields.")
def bundled_formwork(ctx):
    session = current()
    sections = ctx.input.section_by_id()
    groups: dict[tuple, list[tuple[Line, dict[str, Any]]]] = {}
    for line, data in extracted(ctx):
        if data["item_type"] not in ("sandwich_plinth", "precast_element"):
            continue
        thickness = _get(data, "layers.total_thickness_cm")
        height = data["height_m"]
        inside, outside = data["surface_inside"], data["surface_outside"]
        colour = data[COLOUR_FIELD] if data["is_through_colored"] else None
        if not all((thickness, height, data["concrete_grade"], inside, outside)) or data["is_through_colored"] and not colour:
            continue
        layer_sizes = tuple(_get(data, f"layers.{name}") for name in (
            "facing_shell_cm", "insulation_cm", "structural_shell_cm"))
        if data["item_type"] == "sandwich_plinth" and not all(layer_sizes):
            continue
        key = (line.section_id, data["item_type"], thickness, height, data["concrete_grade"],
               inside, outside, colour, layer_sizes)
        groups.setdefault(key, []).append((line, data))
    for key, members in groups.items():
        if len(members) < 2:
            continue
        lengths = [_bundled_length(line, data) for line, data in members]
        total = sum(lengths) if all(length is not None for length in lengths) else None
        codes = [line.code for line, _ in members]
        section_id, item_type, thickness, height, grade, inside, outside, colour, layer_sizes = key
        cross_section = {"total_thickness_cm": thickness, "height_m": height, "concrete_grade": grade,
                         "surface_inside": inside, "surface_outside": outside, "color_pigment_ral": colour,
                         "is_through_colored": bool(colour), "layer_thicknesses_cm": list(layer_sizes)}
        length_text = f", {total} m in total" if total is not None else ""
        yield ctx.finding(
            section=sections.get(section_id) if section_id else None,
            related_line_ids=[line.id for line, _ in members], origin="llm", model=session.model_id,
            discriminator="|".join(str(part) for part in key[1:]),
            message=f"{len(members)} elements ({codes[0]} – {codes[-1]}) share the stated dimensions (height {height:g} m, thickness {thickness:g} cm), "
                    f"grade {grade}{length_text}. Compare the drawings before pricing shared formwork"
                    f"{' and pigment' if colour else ''}.",
            evidence={"line_codes": codes, "cross_section": cross_section,
                      "total_bundled_precast_length_m": str(total) if total is not None else None,
                      "prompt_version": _version(session.provider)},
        )


def _bundled_length(line: Line, data: dict[str, Any]) -> Decimal | None:
    if data["length_m"] is None:
        return None
    count = line.quantity if line.unit == "ea" and line.quantity else Decimal(1)
    return (Decimal(str(round(data["length_m"], 3))) * count).normalize()


def _checks(missing: list[str]) -> list[str]:
    checks = ["DEP_001"] if any(name in REQUIRED_FIELDS for name in missing) else []
    return checks + (["DEP_002"] if COLOUR_FIELD in missing else [])


def _get(data: dict[str, Any], path: str) -> Any:
    value: Any = data
    for part in path.split("."):
        value = value.get(part) if isinstance(value, dict) else None
    return value


def _join_de(parts: list[str]) -> str:
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " und " + parts[-1]


def _text(line: Line) -> str:
    return f"{line.short_text or ''}\n{line.long_text or ''}"


def _plain(value) -> str | None:
    return None if value is None else format(value, "f")
