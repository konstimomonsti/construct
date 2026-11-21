from base64 import b64encode
from collections import defaultdict
from collections.abc import Mapping
from functools import cache
from io import BytesIO
import json
import os
from pathlib import Path
import re
import shutil
from subprocess import TimeoutExpired, run
from tempfile import TemporaryDirectory
import time
import warnings

from pypdf import PdfReader
from pypdf.errors import PdfReadError
from pypdf.generic import ByteStringObject, IndirectObject, NullObject

from .common import BOM_PDF_ATTACHMENT, Result, decimal_text, german_decimal, local_name, parse_xml, xml_element
from .ocr_codes import reread_codes

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
_OCR_BLANK_UNIT = re.compile(rf"^({_NUMBER})[ \t]{{2,}}({_NUMBER})[ \t]{{2,}}({_NUMBER})$")
_JOINED_QUANTITY = re.compile(rf"^(?P<quantity>{_NUMBER})(?P<unit>[^\s\d]\S*)(?P<tail>[ \t]+EP\b.*)$", re.I)
_UNIT = re.compile(r"^(?:m(?:[²³23])?(?:wo|d)?|cm[²23]?|mm|km[²2]?|kg|t|to|l|kwh|st(?:k|ck)?\.?|stwo|satz|set|pau|psch\.?|h|std\.?|wo\.?|mt\.?|mo\.?|d|j(?:r|ahre?)|lfm)$", re.I)
_TOTAL = re.compile(rf"^\s*(?P<label>(?:Summe|Gesamt(?:betrag|summe|preis)|Angebotssumme|Übertrag|MwSt|USt|zzgl\. Mehrwertsteuer|Mehrwertsteuer|Nachlass)[^\n]*?)[ \t]{{2,}}(?:EUR\s+)?(?P<amount>{_NUMBER})\s*(?:EUR|€)?\s*$", re.I)
_NOTE_TITLE = re.compile(r"^(?:Spezifikation\s+\S|Vorbemerkung(?:en)?\b|.{1,60}\s+-\s+Vorbemerkung(?:en)?\b)", re.I)
_REDACTED_LINE = re.compile(r"\[(?:FIRMA|PERSON|ORT|ADRESSE|TELEFON)_\d+\]", re.I)
_PRICE_PREFIX = re.compile(r"^(?:EP|GP)\s*", re.I)
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


OCR_PAGE_LIMIT = 8
OCR_SECONDS = 60
OCR_RASTER_SIZE = 2400
OCR_DPI = 240
OCR_UNIT_LIMIT = 8
OCR_UNIT_PADDING = 8
_OCR_UNIT_TOKEN = re.compile(r"(?<!\S)(?:m\?|mo)(?!\S)", re.I)
_OCR_UNIT_ROW = re.compile(
    rf"^[ \t]*{_NUMBER}[ \t]+(?:"
    rf"(?P<superscript>m\?)[ \t]{{2,}}{_NUMBER}[ \t]{{2,}}{_NUMBER}"
    r"|(?P<linear>mo)(?:[ \t]{2,}\S[^\n]*)?)[ \t]*$", re.M | re.I,
)
_OCR_UNIT_READINGS = {
    "m?": {"m2": "m²", "m²": "m²", "m3": "m³", "m³": "m³"},
    "mo": {"m": "m"},
}


def _reread_ocr_units(layout, boxes, render, recognize):
    """Retry confusable units in one price column, keeping the original reading."""
    rows = list(_OCR_UNIT_ROW.finditer(layout))
    if not 0 < len(rows) <= OCR_UNIT_LIMIT or len(_OCR_UNIT_TOKEN.findall(layout)) != len(rows):
        return layout, []

    words = parse_xml(boxes(), generated=True)
    scale = OCR_DPI / 72
    unit_boxes = sorted(
        tuple(round(float(word.get(key, "")) * scale) for key in ("yMin", "xMin", "yMax", "xMax"))
        + (word.text,)
        for word in words.iter() if local_name(word) == "word" and _OCR_UNIT_TOKEN.fullmatch(word.text or "")
    )
    originals = [row[row.lastgroup] for row in rows]
    if [token for *_, token in unit_boxes] != originals:
        return layout, []
    # Both representations must describe one column of separate rows. A second
    # column or a reference in prose makes this alignment ambiguous.
    tops, lefts, bottoms, _, _ = zip(*unit_boxes)
    if max(lefts) - min(lefts) > 12 or any(bottom >= top for bottom, top in zip(bottoms, tops[1:])):
        return layout, []

    rereads = []
    for row, (top, left, bottom, right, original) in zip(rows, unit_boxes):
        if not (0 <= left < right <= OCR_RASTER_SIZE and 0 <= top < bottom <= OCR_RASTER_SIZE):
            continue
        x, y = max(0, left - OCR_UNIT_PADDING), max(0, top - OCR_UNIT_PADDING)
        w = min(OCR_RASTER_SIZE, right + OCR_UNIT_PADDING) - x
        h = min(OCR_RASTER_SIZE, bottom + OCR_UNIT_PADDING) - y
        image = render(["-x", str(x), "-y", str(y), "-W", str(w), "-H", str(h)])
        readings = [recognize(image, mode).decode("utf-8", errors="replace").strip() for mode in ("7", "8")]
        candidates = _OCR_UNIT_READINGS[original.casefold()]
        unit = candidates.get(readings[0].casefold())
        if unit and candidates.get(readings[1].casefold()) == unit:
            offset = row.start(row.lastgroup)
            rereads.append({"offset": offset, "line": layout.count("\n", 0, offset) + 1,
                            "original": original, "readings": readings, "unit": unit,
                            "bbox_px": [left, top, right, bottom]})
    for reread in reversed(rereads):
        offset = reread["offset"]
        layout = layout[:offset] + reread["unit"] + layout[offset + len(reread["original"]):]
    return layout, rereads


_OCR_MEASUREMENT_HEADER = re.compile(r"\bMenge\s+ME\s+Einheitspreis\b", re.I)
_OCR_MEASUREMENT_ROW = re.compile(
    rf"^(?P<indent>[ \t]+)(?P<quantity>{_NUMBER})[ \t]+(?P<unit>\S+)(?P<tail>.*)$"
)
_OCR_MEASUREMENT_LIMIT = 12
_OCR_NUMBER = re.compile(_NUMBER)
_NUMERIC_PUNCTUATION = str.maketrans("", "", ".,")


def _reread_ocr_measurements(layout, boxes, render, recognize):
    """Re-read OCR-damaged, unpriced measurement cells using the printed table columns."""
    lines = layout.splitlines(keepends=True)
    header = find_header(lines)
    if not header or not _OCR_MEASUREMENT_HEADER.search(header[1].string):
        return layout, []
    rows = defaultdict(list)
    for number, line in enumerate(lines[header[0]:], header[0] + 1):
        if row := _OCR_MEASUREMENT_ROW.fullmatch(line.rstrip("\r\n")):
            rows[(row["quantity"], row["unit"])].append((number, row))

    def eligible(row):
        quantity, unit, tail = row["quantity"], row["unit"].casefold(), row["tail"]
        if _UNIT.fullmatch(unit) and unit not in {"mo", "mm"} and quantity.count(".") < 2:
            return False
        cells = re.split(r"[ \t]{2,}", tail.strip())
        return not any(german_decimal(_PRICE_PREFIX.sub("", cell)) is not None for cell in cells)

    if not any(eligible(row) for entries in rows.values() for _, row in entries):
        return layout, []
    xml = parse_xml(boxes(), generated=True)
    scale = OCR_DPI / 72
    words = sorted(
        (tuple(round(float(word.get(key, "")) * scale) for key in ("yMin", "xMin", "yMax", "xMax")), word.text)
        for word in xml.iter() if local_name(word) == "word" and word.text
    )
    headings = [bbox for bbox, word in words if word.casefold() == "menge"]
    if len(headings) != 1:
        return layout, []
    top, left, bottom, _ = headings[0]
    same_row = [(bbox, word.casefold()) for bbox, word in words if top <= bbox[0] <= bottom and bbox[1] > left]
    columns = {word: bbox[1] for bbox, word in same_row if word in {"me", "einheitspreis"}}
    unit_x, price_x = columns.get("me", 0), columns.get("einheitspreis", 0)
    if not 0 < left < unit_x < price_x <= OCR_RASTER_SIZE or price_x - unit_x < 80:
        return layout, []

    coordinates = defaultdict(list)
    for index, (quantity_box, quantity) in enumerate(words):
        y, x, y_end, x_end = quantity_box
        if y <= bottom or not left - 28 <= x_end < unit_x or not _OCR_NUMBER.fullmatch(quantity):
            continue
        candidates = [(bbox, unit) for bbox, unit in words[index + 1:] if abs(bbox[0] - y) <= 5
                      and unit_x - 8 <= bbox[1] <= unit_x + 24]
        if len(candidates) == 1:
            unit_box, token = candidates[0]
            coordinates[(quantity, token)].append((min(y, unit_box[0]), x, max(y_end, unit_box[2])))

    evidence = []
    attempts = 0
    for key, entries in rows.items():
        matched = coordinates.get(key, [])
        if len(matched) != len(entries):
            continue
        for (number, row), (y, x, bottom) in zip(entries, matched):
            if attempts >= _OCR_MEASUREMENT_LIMIT or not eligible(row):
                continue
            left, top = x - 8, y - 10
            right, end = price_x - 28, bottom + 8
            if not (0 <= left < right <= OCR_RASTER_SIZE and 0 <= top < end <= OCR_RASTER_SIZE):
                continue
            attempts += 1
            image = render(["-x", str(left), "-y", str(top), "-W", str(right - left), "-H", str(end - top)])
            readings = [recognize(image, mode).decode("utf-8", errors="replace").split() for mode in ("6", "7")]
            if len(readings[0]) != 2 or readings[0] != readings[1]:
                continue
            quantity, unit = readings[0]
            if (not _OCR_NUMBER.fullmatch(quantity) or not _UNIT.fullmatch(unit)
                    or quantity.translate(_NUMERIC_PUNCTUATION) != key[0].translate(_NUMERIC_PUNCTUATION)):
                continue
            if (quantity, unit.casefold()) == (key[0], key[1].casefold()):
                continue
            new_line = f'{row["indent"]}{quantity} {unit}{row["tail"]}'
            if read_quantity(new_line) is None:
                continue
            lines[number - 1] = new_line + "\n"
            evidence.append({"line": number, "original_quantity": key[0], "original_unit": key[1],
                             "readings": readings, "quantity": quantity, "unit": unit,
                             "bbox_px": [left, top, right, end]})
    return "".join(lines), evidence


def _ocr_layout(source, pages, result):
    """Use optional local OCR on a bounded set of raster-only pages."""
    if not pages or os.environ.get("PDF_OCR", "").strip().casefold() in {"0", "off", "false"}:
        return {}
    tesseract = shutil.which("tesseract")
    if not tesseract:
        return {}
    deadline = time.monotonic() + OCR_SECONDS

    def execute(arguments, *, data=None):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutExpired(arguments, OCR_SECONDS)
        completed = run(arguments, input=data, capture_output=True, timeout=min(remaining, 20), check=False,
                        env={**os.environ, "OMP_THREAD_LIMIT": "1"})
        if completed.returncode:
            raise ValueError("Local OCR tool did not complete")
        return completed.stdout

    try:
        languages = set(execute([tesseract, "--list-langs"]).decode("utf-8", errors="replace").splitlines())
        language = "+".join(name for name in ("deu", "eng") if name in languages)
        rasterizer = poppler_program("pdftoppm")
        text_extractor = poppler_program("pdftotext")
    except (OSError, ValueError, TimeoutExpired):
        return {}
    if not language:
        return {}

    found = {}
    for number in pages[:OCR_PAGE_LIMIT]:
        try:
            raster = [rasterizer, "-f", str(number), "-l", str(number), "-scale-to",
                      str(OCR_RASTER_SIZE), "-singlefile", "-png"]
            ocr = [tesseract, "stdin", "stdout", "-l", language, "--dpi", str(OCR_DPI)]
            image = execute([*raster, str(source)])
            searchable = execute([*ocr, "pdf"], data=image)
            layouts = split_layout(execute([text_extractor, "-enc", "UTF-8", "-layout", "-", "-"],
                                           data=searchable))
        except TimeoutExpired:
            result.warn("pdf_ocr_incomplete", {"page": number}, "The local OCR time limit was reached.")
            break
        except (OSError, ValueError):
            result.warn("pdf_ocr_incomplete", {"page": number}, "The page could not be read by local OCR.")
            continue
        if len(layouts) == 1 and layouts[0].strip():
            original = revised = measurements = codes = layouts[0]
            unit_rereads, measurement_rereads, code_rereads = [], [], []

            @cache
            def boxes():
                return execute([text_extractor, "-enc", "UTF-8", "-bbox", "-", "-"], data=searchable)

            def render(args):
                return execute([*raster, *args, str(source)])

            def recognize(crop, mode):
                return execute([*ocr, "--psm", mode], data=crop)

            def render_codes(bounds):
                x, y, width, height = map(str, bounds)
                return execute([rasterizer, "-f", str(number), "-l", str(number), "-scale-to",
                                str(OCR_RASTER_SIZE * 2), "-singlefile", "-gray", "-x", x, "-y", y,
                                "-W", width, "-H", height, str(source)])

            def recognize_codes(crop, mode):
                return execute([*ocr, "--psm", mode, "-c", "tessedit_char_whitelist=0123456789.", "tsv"], data=crop)

            try:
                revised, unit_rereads = _reread_ocr_units(original, boxes, render, recognize)
                measurements, measurement_rereads = _reread_ocr_measurements(original, boxes, render, recognize)
                codes, code_rereads = reread_codes(
                    original, find_header(original.splitlines()), boxes, render_codes, recognize_codes,
                    dpi=OCR_DPI, raster_size=OCR_RASTER_SIZE,
                )
            except (OSError, SyntaxError, ValueError, TimeoutExpired):
                # Preserve completed reads if an optional retry fails.
                pass
            revised_lines = revised.splitlines(keepends=True)
            measurement_lines = measurements.splitlines(keepends=True)
            evidence = {item["line"]: {"unit_ocr": item} for item in unit_rereads}
            for item in measurement_rereads:
                line = item["line"]
                revised_lines[line - 1] = measurement_lines[line - 1]
                evidence[line] = {"measurement_ocr": item}
            code_lines = codes.splitlines(keepends=True)
            for item in code_rereads:
                line = item["line"]
                revised_lines[line - 1] = code_lines[line - 1]
                evidence[line] = {"code_ocr": item}
            found[number] = "".join(revised_lines), evidence
            result.add("pdf_ocr_page", {"page": number, "ocr_pages": [number]}, layout=original,
                       language=language, unit_rereads=unit_rereads, measurement_rereads=measurement_rereads,
                       code_rereads=code_rereads)
    if len(pages) > OCR_PAGE_LIMIT:
        result.warn("pdf_ocr_page_limit", {"page": pages[OCR_PAGE_LIMIT]},
                    f"Only the first {OCR_PAGE_LIMIT} raster-only pages are eligible for local OCR in one import.")
    return found


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
        raster_pages = set()
        for program, args, record_kind in [
            ("pdfinfo", ("-isodates", "-box", source), "pdf_info"),
            ("pdfinfo", ("-meta", source), "pdf_xmp"),
            ("pdfimages", ("-list", source), "pdf_image_inventory"),
            ("pdfdetach", ("-list", source), "pdf_attachment_inventory"),
        ]:
            try:
                content = poppler(program, *args).decode("utf-8", errors="replace")
                result.add(record_kind, {"part": record_kind}, text=content)
                if record_kind == "pdf_image_inventory":
                    raster_pages = {int(page) for page in re.findall(r"^\s*(\d+)\s+\d+\s+image\b", content, re.M)}
            except ValueError as exc:
                result.warn("pdf_inventory_review", {"part": record_kind}, str(exc))

        page_count = max(len(layout), len(bbox_pages), len(structures))
        result.metadata["pages"] = page_count
        if len(layout) != len(bbox_pages) or (structures and len(structures) != page_count):
            result.warn("pdf_page_count_mismatch", {"part": "document"}, "PDF representations returned different page counts")
        native = [layout[index] if index < len(layout) else "" for index in range(page_count)]
        for number, raw_page in enumerate(native, 1):
            result.add(
                "pdf_page", {"page": number}, layout=raw_page,
                word_boxes=xml_element(bbox_pages[number - 1]) if number <= len(bbox_pages) else None,
                structure=structures[number - 1] if number <= len(structures) else None,
            )
        if not extract_workspace_attachment(data, result):
            scanned = [number for number, raw_page in enumerate(native, 1)
                       if not raw_page.strip() and number in raster_pages]
            ocr = _ocr_layout(source, scanned, result)
            if ocr:
                result.metadata["ocr_pages"] = sorted(ocr)
            for number, raw_page in enumerate(native, 1):
                if number not in ocr and not raw_page.strip():
                    result.warn("page_has_no_extractable_text", {"page": number}, "Inspect the page image or run OCR")
            pages = [ocr[number][0] if number in ocr else raw_page for number, raw_page in enumerate(native, 1)]
            ocr_evidence = {(page, row): {field: {"page": page, **item} for field, item in evidence.items()}
                            for page, (_, rows) in ocr.items() for row, evidence in rows.items()}
            extract_pdf_tables(pages, result, ocr_pages=ocr.keys(), ocr_evidence=ocr_evidence)
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


def read_quantity(body, *, ocr=False):
    stripped = body.strip()
    if ocr and (missing_unit := _OCR_BLANK_UNIT.fullmatch(stripped)):
        quantity, *prices = missing_unit.groups()
        return {
            "quantity_raw": quantity, "quantity": german_decimal(quantity), "unit": None,
            "unit_price": german_decimal(prices[0]), "line_amount": german_decimal(prices[1]),
            "price_cells_raw": prices, "unit_price_only": False,
        }
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
    values =[german_decimal(_PRICE_PREFIX.sub("", cell)) for cell in cells]
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


def extract_pdf_tables(pages, result, *, ocr_pages=(), ocr_evidence=None):
    current = None
    note = None
    section_paths = []
    sections_seen = set()

    def flush():
        nonlocal current
        if current is None:
            return
        locator = current.pop("locator")
        pages_read_by_ocr = sorted(page for page in ocr_pages if locator["page"] <= page <= locator["end_page"])
        if pages_read_by_ocr:
            locator["ocr_pages"] = pages_read_by_ocr
        if ocr_evidence:
            locator.update(ocr_evidence.get((locator["page"], locator["line"]), {}))
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
            if ocr_evidence and (quantity_locator := current.get("quantity_locator")):
                key = (quantity_locator["page"], quantity_locator["line"])
                locator.update(ocr_evidence.get(key, {}))
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
                numbers = read_quantity(
                    raw, ocr=page_number in ocr_pages
                    and bool(re.search(r"\bMenge\s+ME\s+Einheitspreis\s+Gesamtbetrag\b", header.string, re.I)),
                )
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
