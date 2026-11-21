from base64 import b64encode
from collections.abc import Mapping
from io import BytesIO
import json
import os
from pathlib import Path
import re
import shutil
from subprocess import run
from tempfile import TemporaryDirectory
import warnings

from pypdf import PdfReader
from pypdf.errors import PdfReadError
from pypdf.generic import ByteStringObject, IndirectObject, NullObject

from .common import BOM_PDF_ATTACHMENT, Result, decimal_text, german_decimal, local_name, parse_xml, xml_element

_NUMBER = r"[+\-−]?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?"
_CODE = re.compile(r"^(?P<indent> *)(?P<code>\d+(?:\.\d+)*\.?|\.\d+)[ \t]{2,}(?P<body>\S.*)$")
_SECTION = re.compile(
    r"^(?P<indent> *)(?P<code>\d+(?:\.\d+)*)[ \t]+(?:Titel|Bereich|Los|Abschnitt|Gewerk)[ \t]+(?P<label>\S.*)$", re.I
)
_HEADER = re.compile(r"^(?P<indent> *)(?P<code>OZ\b|Ordnungszahl\b|Pos-Nr\.|Pos\b|Nr\.).*(?:Menge|Stl-Nr)", re.I)
# A header whose cells wrapped over several lines: the first cell starts the line, "Menge" follows within two lines.
_HEADER_START = re.compile(r"^(?P<indent> *)(?P<code>OZ\b|Ordnungszahl\b|Pos-Nr\.|Pos\b|Nr\.)", re.I)
# "*** Bedarfsposition ohne GB" and similar marker lines are not a short text.
_FALLBACK_QUANTITY = re.compile(rf"(?<![\w.,])(?P<quantity>{_NUMBER})[ \t]+(?P<unit>\S+?)[ \t]*\.{{3,}}")
_MARKER_LINE = re.compile(r"^\*{2,}\s*(?:Bedarfs|Wahl|Grund|Eventual|Alternativ)-?position", re.I)
# One space is enough before a dotted price tail ("1,000 PSCH ....."); otherwise the tail needs two.
_QUANTITY = re.compile(
    rf"^(?P<quantity>{_NUMBER})\s+(?P<unit>\S+)(?P<tail>(?:(?:[ \t]{{2,}}|[ \t]+(?=\.{{3,}}))\S.*)?)$"
)
_JOINED_QUANTITY = re.compile(rf"^(?P<quantity>{_NUMBER})(?P<unit>[^\s\d]\S*)(?P<tail>[ \t]+EP\b.*)$", re.I)
_UNIT = re.compile(r"^(?:m(?:[²³23])?(?:wo|d)?|cm[²23]?|mm|km[²2]?|kg|t|to|l|kwh|st(?:k|ck)?\.?|stwo|satz|set|pau|psch\.?|h|std\.?|wo\.?|mt\.?|mo\.?|d|j(?:r|ahre?)|lfm)$", re.I)
_TOTAL = re.compile(rf"^\s*(?P<label>(?:Summe|Gesamt(?:betrag|summe|preis)|Angebotssumme|Übertrag|MwSt|USt|zzgl\. Mehrwertsteuer|Mehrwertsteuer|Nachlass)[^\n]*?)[ \t]{{2,}}(?:EUR\s+)?(?P<amount>{_NUMBER})\s*(?:EUR|€)?\s*$", re.I)
_NOTE_TITLE = re.compile(r"^(?:Spezifikation\s+\S|Vorbemerkung(?:en)?\b|.{1,60}\s+-\s+Vorbemerkung(?:en)?\b)", re.I)
_REDACTED_LINE = re.compile(r"\[(?:FIRMA|PERSON|ORT|ADRESSE|TELEFON)_\d+\]", re.I)
_PRICE_ONLY = re.compile(r"nur\s+(?:einh[. -]*pr\.?|einheitspreis|EP)\b", re.I)
_FORM = re.compile(r"^\s*(\d{3}(?:\.[A-Z][A-Za-z]*)?)\s*$")
_SUMMARY_TITLE = re.compile(r"^\s*(?:LV-Zusammenfassung|(?:Gesamt)?Zusammenstellung|Inhaltsverzeichnis)\s*$", re.I)
_XML_CONTROLS = re.compile(rb"[\x00-\x08\x0b\x0c\x0e-\x1f]")


_POPPLER_CHECKED: set[str] = set()


def poppler_program(program):
    """Resolve a Poppler tool, from the folder in POPPLER_BIN when that variable is set."""
    base = os.environ.get("POPPLER_BIN", "").strip().strip('"')
    if not base:
        return program
    folder = Path(base)
    if folder.is_file():
        folder = folder.parent
    found = shutil.which(program, path=str(folder))
    if not found:
        raise ValueError(f"{program} was not found in POPPLER_BIN={base}")
    return found


def check_poppler_banner(banner, program="pdftotext"):
    """Refuse xpdf: it also calls itself pdftotext but scrambles the column layout of tables."""
    lowered = banner.casefold()
    if "poppler" in lowered:
        return
    if "xpdf" in lowered or "glyph & cog" in lowered:
        raise ValueError(
            f"{program} is xpdf, not Poppler, and scrambles the table layout of PDF files. "
            "Install Poppler (https://poppler.freedesktop.org) and put it first on the PATH, "
            "or set POPPLER_BIN to the folder that holds Poppler's tools.")
    warnings.warn(f"Could not tell whether {program} is Poppler (its version banner is unrecognised); "
                  "PDF table extraction needs Poppler.", stacklevel=3)


def check_poppler():
    """Run `pdftotext -v` once per binary and refuse a non-Poppler build."""
    program = poppler_program("pdftotext")
    if program in _POPPLER_CHECKED:
        return
    try:
        completed = run([program, "-v"], capture_output=True, timeout=30, check=False)
    except FileNotFoundError:
        raise ValueError("pdftotext was not found. Install Poppler and put it on the PATH, "
                         "or set POPPLER_BIN to the folder that holds Poppler's tools.") from None
    check_poppler_banner((completed.stdout + completed.stderr).decode("utf-8", errors="replace"), program)
    _POPPLER_CHECKED.add(program)


def poppler(program, *args):
    check_poppler()
    program = poppler_program(program)
    completed = run([program, *map(str, args)], capture_output=True, timeout=90, check=False)
    if completed.returncode:
        message = completed.stderr.decode("utf-8", errors="replace").strip()
        raise ValueError(f"{program} failed ({completed.returncode}): {message}")
    return completed.stdout


def pdf_value(value):
    if isinstance(value, IndirectObject):
        return {"object_number": value.idnum, "generation": value.generation}
    if isinstance(value, ByteStringObject) or isinstance(value, bytes):
        return {"base64": b64encode(value).decode("ascii")}
    if isinstance(value, Mapping):
        return {key: pdf_value(val) for key, val in value.items()}
    if isinstance(value, (list, tuple)):
        return [pdf_value(element) for element in value]
    if isinstance(value, NullObject) or value is None:
        return None
    if hasattr(value, "value") and isinstance(value.value, bool):
        return value.value
    if isinstance(value, (int, float)):
        return value
    return str(value)


def pdf_structure(data, result) -> list[dict]:
    reader = PdfReader(BytesIO(data))
    if reader.is_encrypted:
        raise ValueError("Password-protected PDF needs to be decrypted before extracting fields")
    root = reader.root_object
    result.add("pdf_catalog", {"part": "catalog"}, metadata=pdf_value(reader.metadata),
               catalog=pdf_value(root), trailer=pdf_value(reader.trailer),
               attachments=list(reader.attachments))
    fields = reader.get_fields() or {}
    for index, (name, field) in enumerate(fields.items(), 1):
        result.add("pdf_form_field", {"field": name, "index": index}, field=pdf_value(field))
    pages = []
    for number, page in enumerate(reader.pages, 1):
        annots = []
        annot_refs = page.get("/Annots", [])
        if isinstance(annot_refs, IndirectObject):
            annot_refs = annot_refs.get_object()
        for ref in annot_refs:
            annotation = ref.get_object()
            annots.append({"reference": pdf_value(ref), "data": pdf_value(annotation)})
        # The page dictionary keeps graphics/resource references without expanding their streams.
        pages.append({"page": number, "dictionary": pdf_value(page), "annotations": annots})
    return pages


def split_layout(raw: bytes) -> list[str]:
    pages = raw.decode("utf-8", errors="replace").split("\f")
    if pages[-1] == "":
        pages.pop()
    return pages


def pdf(data: bytes) -> Result:
    result = Result("pdf", needs_review=True)
    with TemporaryDirectory() as directory:
        source = Path(directory) / "source.pdf"
        source.write_bytes(data)
        layout = split_layout(poppler("pdftotext", "-enc", "UTF-8", "-layout", source, "-"))
        try:
            bbox_data = poppler("pdftotext", "-enc", "UTF-8", "-bbox-layout", source, "-")
            controls = [{"offset": match.start(), "byte": match[0].hex()} for match in _XML_CONTROLS.finditer(bbox_data)]
            if controls:
                result.add("pdf_box_controls", {"part": "bounding_boxes"}, original_controls=controls)
                result.warn("pdf_control_glyphs", {"part": "bounding_boxes"},
                            "Control glyphs were encoded as visible markers in the positional text")
            xml_data = _XML_CONTROLS.sub(lambda match: f"[U+{ord(match[0]):04X}]".encode("ascii"), bbox_data)
            boxes = parse_xml(xml_data, generated=True)
            bbox_pages = [page for page in boxes.iter() if local_name(page) == "page"]
        except (SyntaxError, ValueError) as exc:
            bbox_pages = []
            result.warn("pdf_bounding_boxes_review", {"part": "bounding_boxes"}, str(exc))
        try:
            structures = pdf_structure(data, result)
        except (PdfReadError, ValueError, TypeError, KeyError) as exc:
            structures = []
            result.warn("pdf_structure_review", {"part": "catalog"}, str(exc))
        for program, args, record_kind in [
            ("pdfinfo", ("-isodates", "-box", source), "pdf_info"),
            ("pdfinfo", ("-meta", source), "pdf_xmp"),
            ("pdfimages", ("-list", source), "pdf_image_inventory"),
            ("pdfdetach", ("-list", source), "pdf_attachment_inventory"),
        ]:
            try:
                content = poppler(program, *args).decode("utf-8", errors="replace")
                result.add(record_kind, {"part": record_kind}, text=content)
            except ValueError as exc:
                result.warn("pdf_inventory_review", {"part": record_kind}, str(exc))

    page_count = max(len(layout), len(bbox_pages), len(structures))
    result.metadata["pages"] = page_count
    if len(layout) != len(bbox_pages) or (structures and len(structures) != page_count):
        result.warn("pdf_page_count_mismatch", {"part": "document"}, "PDF representations returned different page counts")
    for number in range(1, page_count + 1):
        raw_page = layout[number - 1] if number <= len(layout) else ""
        if not raw_page.strip():
            result.warn("page_has_no_extractable_text", {"page": number}, "Inspect the page image or run OCR")
        result.add(
            "pdf_page", {"page": number}, layout=raw_page,
            word_boxes=xml_element(bbox_pages[number - 1]) if number <= len(bbox_pages) else None,
            structure=structures[number - 1] if number <= len(structures) else None,
        )
    if not extract_workspace_attachment(data, result):
        extract_pdf_tables(layout, result)
    return result


def extract_workspace_attachment(data, result):
    try:
        reader = PdfReader(BytesIO(data))
        if reader.is_encrypted or BOM_PDF_ATTACHMENT not in reader.attachments:
            return False
        attachments = reader.attachments[BOM_PDF_ATTACHMENT]
        if len(attachments) != 1 or len(attachments[0]) > 4 * 1024 * 1024:
            raise ValueError("Unexpected BOM attachment size or count")
        draft = json.loads(attachments[0])
        rows = draft["lines"]
        if not isinstance(rows, list) or not 0 < len(rows) <= 10_000 or not re.fullmatch(r"[A-Z]{3}", draft["currency"]):
            raise ValueError("Invalid BOM attachment structure")
        strings = ("line_code", "short_description", "long_description", "unit_code")
        decimals = ("quantity", "draft_unit_price", "line_amount")
        if any(not isinstance(row, dict) or not isinstance(row.get("short_description"), str)
               or any(row.get(field) is not None and not isinstance(row[field], str) for field in (*strings, *decimals))
               or row.get("total_rule") not in {"include", "conditional", "unit_price_only"}
               or row.get("pricing_basis") not in {"lump_sum", "unit_rate"}
               for row in rows):
            raise ValueError("Invalid BOM attachment positions")
    except (PdfReadError, ValueError, TypeError, KeyError, UnicodeError) as error:
        result.warn("invalid_workspace_attachment", {"part": BOM_PDF_ATTACHMENT}, str(error))
        return False
    result.metadata["currency"] = draft["currency"]
    for index, row in enumerate(rows, 1):
        result.add("item_candidate", {"part": BOM_PDF_ATTACHMENT, "row": index},
                   code=row.get("line_code"), short_description=row["short_description"],
                   long_description=row.get("long_description"), unit=row.get("unit_code"),
                   quantity=decimal_text(row.get("quantity")), unit_price=decimal_text(row.get("draft_unit_price")),
                   line_amount=decimal_text(row.get("line_amount")), confidence="review",
                   flags={"LumpSumItem": "Yes" if row["pricing_basis"] == "lump_sum" else "No",
                          "unit_price_only": row["total_rule"] == "unit_price_only",
                          "alternative_item": row["total_rule"] == "conditional"})
    return True


def read_quantity(body):
    stripped = body.strip()
    match = _QUANTITY.fullmatch(stripped) or _JOINED_QUANTITY.fullmatch(stripped)
    if not match:
        return None
    qty = match["quantity"]
    cells = re.split(r"[ \t]{2,}", match["tail"].strip()) if match["tail"].strip() else []
    unit = match["unit"]
    if re.fullmatch(r"\.{3,}", unit):
        # With both price cells present, the dots occupy the unit column. Otherwise
        # they may be the first price placeholder on a line that has no unit at all.
        if len(cells) < 2:
            cells = [unit, *cells]
        unit = None
    values =[german_decimal(re.sub(r"^(?:EP|GP)\s*", "", cell, flags=re.I)) for cell in cells]
    price_only = bool(_PRICE_ONLY.search(match["tail"]))
    if unit is not None and not _UNIT.fullmatch(unit) and not (
        len(cells) >= 2 and all(value is not None or re.fullmatch(r"\.{2,}", cell) for value, cell in zip(values, cells))
    ):
        return None
    # Two right-hand cells preserve the distinction between an actual zero and a blank placeholder.
    return {
        "quantity_raw": qty, "quantity": german_decimal(qty), "unit": unit,
        "unit_price": values[0] if values else None,
        "line_amount": values[1] if len(values) > 1 else None,
        "price_cells_raw": cells, "unit_price_only": price_only,
    }


def fallback_quantity(text):
    """Safety net: a `<number> <unit> .....` anywhere in the item's lines, where the table layout failed."""
    for line in reversed(text.splitlines()):
        match = _FALLBACK_QUANTITY.search(line)
        if match and _UNIT.fullmatch(match["unit"]):
            return {"quantity_raw": match["quantity"], "quantity": german_decimal(match["quantity"]),
                    "unit": match["unit"], "unit_price": None, "line_amount": None, "price_cells_raw": [],
                    "unit_price_only": False, "quantity_source": "fallback"}
    return None


def quantity_rank(amounts):
    if amounts["price_cells_raw"]:
        return 2
    return int("," in amounts["quantity_raw"])


def is_item_code(code, header):
    if code.startswith("."):
        return True
    groups = code.rstrip(".").split(".")
    if len(groups) >= 3:
        return True
    if len(groups) == 2 and not code.endswith("."):
        return header != "pos-nr." or len(groups[1]) >= 3
    return False


def item_flags(description):
    lowered = description.casefold()
    return {
        "unit_price_only": bool(_PRICE_ONLY.search(description)) or "ohne gb" in lowered or "ohne gesamtbetrag" in lowered,
        "provisional_included": "bedarfsposition mit gb" in lowered,
        "base_item": "grundposition" in lowered,
        "alternative_item": "wahlposition" in lowered or "alternativposition" in lowered,
    }


def find_header(lines):
    """Return (line number the header ends on, regex match) for the page's table header, or None."""
    for number, line in enumerate(lines, 1):
        if match := _HEADER.match(line):
            # Some continuation layouts place "Menge" on the first wrapped line.
            # The remaining header cells can resemble quantities with trailing prose.
            for offset, other in enumerate(lines[number:number + 4], 1):
                if other.strip().startswith("Nr.)"):
                    return number + offset, match
            return number, match
    for number, line in enumerate(lines, 1):
        match = _HEADER_START.match(line)
        if not match:
            continue
        following = lines[number:number + 2]
        if not any("menge" in other.casefold() for other in following):
            continue
        # Cells that wrapped over several lines end on the line that begins with "Nr.)".
        end = number
        for offset, other in enumerate(lines[number:number + 3], 1):
            if other.strip().startswith("Nr.)"):
                end = number + offset
                break
        else:
            end = number + 1 + next((i for i, other in enumerate(following) if "menge" in other.casefold()), 0)
        return end, match
    return None


def extends_code(code, parent):
    """True when `code` is a descendant of `parent` ("1.3.1.1" extends "1.3.1.")."""
    parent = parent.rstrip(".")
    return code.rstrip(".").startswith(parent + ".") and len(code.rstrip(".")) > len(parent)


def detached_note_title(line, following):
    if _NOTE_TITLE.match(line):
        return True
    # Some schedules repeat a short section title above a preamble, with a page label in between.
    if len(line.split()) > 5:
        return False
    repeated = False
    for raw in following:
        candidate = raw.strip()
        if candidate.casefold() == line.casefold():
            repeated = True
        elif not candidate or _REDACTED_LINE.fullmatch(candidate):
            continue
        else:
            return repeated and bool(_NOTE_TITLE.match(candidate))
    return False


def extract_pdf_tables(pages, result):
    current = None
    note = None
    section_paths = []
    sections_seen = set()

    def flush():
        nonlocal current
        if current is None:
            return
        locator = current.pop("locator")
        body = "\n".join(current.pop("description_lines")).strip()
        numbers = current.pop("amounts")
        flags = item_flags(body)
        if not numbers:
            numbers = fallback_quantity(body)
            if numbers:
                result.warn("pdf_quantity_fallback", {**locator, "code": current["code"]},
                            "The quantity was found by a loose scan of the item text; check it against the source")
        if numbers:
            flags["unit_price_only"] |= numbers["unit_price_only"]
        else:
            result.warn("pdf_quantity_review", {**locator, "code": current["code"]},
                        "Review the source evidence for quantity and unit")
        result.add("item_candidate", locator, **current, long_description=body or None,
                   **{key: value for key, value in (numbers or {}).items() if key != "unit_price_only"},
                   flags=flags, confidence="review")
        current = None

    def section_row(code, label, locator):
        depth = len(code.rstrip(".").split("."))
        del section_paths[depth - 1:]
        if len(section_paths) < depth - 1:
            section_paths.extend(_parent_codes(code)[len(section_paths):])
        section_paths.append(code)
        key = tuple(section_paths)
        if key in sections_seen:
            return
        sections_seen.add(key)
        result.add("section_candidate", locator, code=code, label=label, section_path=section_paths[:-1])

    def demote_to_section():
        """An item with no amounts that is followed by its own sub-items is a heading, not an item."""
        nonlocal current
        locator = {key: current["locator"][key] for key in ("page", "line")}
        section_row(current["code"], current["short_description"] or "", locator)
        current = None

    def flush_note():
        nonlocal note
        if note is not None:
            result.add("note", note["locator"], text="\n".join(note["lines"]), section_path=note["section_path"])
            note = None

    for page_number, page in enumerate(pages, 1):
        lines = page.splitlines()
        header_row = find_header(lines)
        form = next((m[1] for line in lines[:10] if (m := _FORM.fullmatch(line))), None)
        if form:
            result.add("form_page", {"page": page_number}, form_code=form, rows=layout_rows(lines))
            header_row = None
        page_head = "\n".join(lines[:24])
        summary_page = any(_SUMMARY_TITLE.fullmatch(line) for line in lines[:16])
        if header_row is None or summary_page:
            flush()
            flush_note()
        for line_number, raw in enumerate(lines, 1):
            locator = {"page": page_number, "line": line_number}
            total = _TOTAL.fullmatch(raw)
            if total:
                result.add("reported_amount", locator, label=total["label"].strip(),
                           amount_raw=total["amount"], amount=german_decimal(total["amount"]))
            if header_row is None or line_number <= header_row[0]:
                continue
            if summary_page:
                continue
            if total or re.match(r"^\s*(?:Übertrag\s*:|Druckdatum:|Seite\s*:)", raw, re.I):
                continue
            header = header_row[1]
            indent = len(header["indent"])
            heading = _SECTION.fullmatch(raw)
            if heading and abs(len(heading["indent"]) - indent) <= 3:
                flush()
                flush_note()
                section_row(heading["code"], heading["label"].strip(), locator)
                continue
            match = _CODE.fullmatch(raw)
            if match and abs(len(match["indent"]) - indent) <= 3:
                flush_note()
                code, body = match["code"], match["body"]
                amounts = read_quantity(body)
                if amounts or is_item_code(code, header["code"].casefold()):
                    if current is not None and current["code"] == code and current["locator"]["page"] < page_number:
                        current.setdefault("continuation_markers", []).append({"locator": locator, "raw": raw})
                        if amounts and current["amounts"] is None:
                            current["amounts"] = amounts
                            current["quantity_locator"] = locator
                        elif not amounts and body.strip() != current["short_description"]:
                            current["description_lines"].append(body.strip())
                        current["locator"].update(end_page=page_number, end_line=line_number)
                        continue
                    if current is not None and current["amounts"] is None and extends_code(code, current["code"]):
                        demote_to_section()
                    flush()
                    current = {
                        "locator": {**locator, "end_page": page_number, "end_line": line_number},
                        "code": code, "section_path": list(section_paths),
                        "short_description": None if amounts or _MARKER_LINE.match(body.strip()) else body.strip(),
                        "description_lines": [] if amounts else [body.strip()], "amounts": amounts,
                        "quantity_locator": locator if amounts else None,
                    }
                else:
                    flush()
                    section_row(code, body.strip(), locator)
                continue
            line = raw.strip()
            if not line:
                continue
            if note is not None:
                note["lines"].append(line)
                note["locator"].update(end_page=page_number, end_line=line_number)
                continue
            if current is not None:
                if raw.strip().startswith(("Nr.)", "in EUR", "Alle Einzelbeträge", "Betrag in EUR")):
                    continue
                numbers = read_quantity(raw)
                if numbers and len(raw) - len(raw.lstrip()) >= indent + 5:
                    previous = current["amounts"]
                    if previous is None or quantity_rank(numbers) > quantity_rank(previous):
                        if previous is not None:
                            current.setdefault("other_amount_candidates", []).append(
                                {"locator": current["quantity_locator"], **previous}
                            )
                        current["amounts"] = numbers
                        current["quantity_locator"] = locator
                    else:
                        current.setdefault("other_amount_candidates", []).append({"locator": locator, **numbers})
                else:
                    amounts = current["amounts"]
                    if (amounts and len(amounts["price_cells_raw"]) >= 2 and current["description_lines"]
                            and current["quantity_locator"]["line"] != current["locator"]["line"]
                            and detached_note_title(line, lines[line_number:line_number + 5])):
                        flush()
                        note = {"locator": locator.copy(), "lines": [line], "section_path": list(section_paths)}
                        continue
                    current["description_lines"].append(line)
                    if current["short_description"] is None and not _MARKER_LINE.match(line):
                        current["short_description"] = line
                current["locator"].update(end_page=page_number, end_line=line_number)
        if "EUR" in page_head:
            result.metadata.setdefault("currency", "EUR")
    flush()
    flush_note()


def _parent_codes(code):
    parts = code.rstrip(".").split(".")
    return [".".join(parts[:depth]) for depth in range(1, len(parts))]


def layout_rows(lines):
    """Preserve flattened form cell order and horizontal offsets without guessing field names."""
    return [
        {"line": index, "cells": [{"offset": cell.start(), "text": cell[0]} for cell in
                                   re.finditer(r"\S+(?:[ \t]\S+)*", line)]}
        for index, line in enumerate(lines, 1) if line.strip()
    ]
