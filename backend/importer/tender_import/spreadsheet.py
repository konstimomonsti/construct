"""Excel and CSV import of a Bill of Quantities.

``excel(data, fmt, mapping=None)`` reads .xlsx, .xls and .csv and emits the same ``item_candidate`` and
``section_candidate`` records as ``pdf.py`` (plus ``reported_amount`` / ``subtotal`` / ``summary`` for printed
totals and one ``boq_header`` per sheet), so ``analysis.adapter.from_import`` and every layer work unchanged.

The column layout is detected from the header row (synonym table, scored); ``mapping`` overrides it.
Nothing is repaired silently: unreadable numbers stay None with their raw text, and every guess that
the user should look at raises an ``excel_*`` warning.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from io import BytesIO, StringIO
import math
import re
from zipfile import BadZipFile, ZipFile

from .common import NUMBER, PRICE_ONLY, UNIT, Result, checked_entries, german_decimal, item_flags

MAX_ROWS = 200_000
HEADER_SCAN_ROWS = 40
HEADER_MIN_SCORE = 6
REVIEW_CONFIDENCE = 0.75
FULL_SCORE = 11  # code + short text + quantity + unit

FIELDS = ("code", "short_text", "long_text", "quantity", "unit", "unit_price", "line_amount",
          "position_type", "section_code")
WEIGHTS = {"code": 3, "short_text": 3, "quantity": 3, "unit": 2, "long_text": 1, "unit_price": 1,
           "line_amount": 1, "position_type": 1, "section_code": 1}

# Normalised header words (lower case, umlauts transliterated, punctuation removed) per field.
SYNONYMS = {
    "code": {"oz", "ordnungszahl", "ordnungszahlen", "pos", "posnr", "posnummer", "position", "positionsnr",
             "positionsnummer", "positionsnum", "nr", "lvpos", "lvposition", "ozlv", "lvoz", "posoz"},
    "short_text": {"kurztext", "kurzbezeichnung", "bezeichnung", "leistung", "leistungsbeschreibung",
                   "leistungsbezeichnung", "text", "beschreibung", "positionstext", "kurzbeschreibung",
                   "titelkurztext"},
    "long_text": {"langtext", "langbeschreibung", "ausfuehrlichertext", "volltext", "detailtext", "langbez",
                  "leistungslangtext", "positionslangtext"},
    "quantity": {"menge", "lvmenge", "vordersatz", "mengevordersatz", "anzahl", "mng", "mge", "mengenansatz",
                 "ausschreibungsmenge", "gesamtmenge"},
    "unit": {"einheit", "me", "eh", "mengeneinheit", "einh", "mengeneinh", "ausfuehrungseinheit"},
    "unit_price": {"ep", "einheitspreis", "einzelpreis", "epnetto", "preisproeinheit", "preisjeeinheit"},
    "line_amount": {"gp", "gesamtpreis", "gesamtbetrag", "betrag", "gb", "positionspreis", "gesamt",
                    "positionsbetrag", "gpnetto", "summe"},
    "position_type": {"posart", "positionsart", "pa", "art", "positionstyp", "typ", "posstatus", "positionsstatus"},
    "section_code": {"titel", "los", "abschnitt", "gewerk", "titelnr", "losnr", "titelnummer"},
}
_LOOKUP = {word: field for field, words in SYNONYMS.items() for word in words}
_NOISE = {"eur", "euro", "netto", "brutto", "in", "lv", "ca"}

# --------------------------------------------------------------------------- loading


@dataclass
class Cell:
    value: object = None
    fmt: str = "General"
    bold: bool = False
    uncached: bool = False  # a formula whose result was never calculated and saved


@dataclass
class Sheet:
    name: str
    rows: list  # list[list[Cell]], padded to the same width
    truncated: bool = False

    @property
    def width(self) -> int:
        return max((len(row) for row in self.rows), default=0)


def _pad(rows: list[list[Cell]]) -> list[list[Cell]]:
    width = max((len(row) for row in rows), default=0)
    return [row + [Cell()] * (width - len(row)) for row in rows]


def load_xlsx(data: bytes) -> list[Sheet]:
    import openpyxl

    try:
        with ZipFile(BytesIO(data)) as archive:
            checked_entries(archive)
    except BadZipFile as exc:
        raise ValueError("The file is not a valid .xlsx workbook (it is not a zip archive)") from exc
    # Macros are never run: openpyxl does not execute VBA and keep_vba stays off.
    values = openpyxl.load_workbook(BytesIO(data), data_only=True)
    formulas = openpyxl.load_workbook(BytesIO(data), data_only=False)
    sheets = []
    for sheet in values.worksheets:
        formula_sheet = formulas[sheet.title]
        rows: list[list[Cell]] = []
        truncated = False
        for row_values, row_formulas in zip(sheet.iter_rows(), formula_sheet.iter_rows()):
            if len(rows) >= MAX_ROWS:
                truncated = True
                break
            cells = []
            for cell, source in zip(row_values, row_formulas):
                value = cell.value
                uncached = value is None and getattr(source, "data_type", None) == "f"
                bold = bool(cell.font and cell.font.b) if value is not None else False
                cells.append(Cell(value, cell.number_format or "General", bold, uncached))
            rows.append(cells)
        while rows and all(c.value is None and not c.uncached for c in rows[-1]):
            rows.pop()
        sheets.append(Sheet(sheet.title, _pad(rows), truncated))
    return sheets


def load_xls(data: bytes) -> list[Sheet]:
    import xlrd

    book = xlrd.open_workbook(file_contents=data, formatting_info=True)
    sheets = []
    for sheet in book.sheets():
        rows: list[list[Cell]] = []
        for row_index in range(min(sheet.nrows, MAX_ROWS)):
            cells = []
            for column in range(sheet.ncols):
                cell = sheet.cell(row_index, column)
                value = cell.value
                if cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK, xlrd.XL_CELL_ERROR):
                    value = None
                elif cell.ctype == xlrd.XL_CELL_DATE:
                    try:
                        value = xlrd.xldate.xldate_as_datetime(value, book.datemode)
                    except Exception:  # noqa: BLE001 - an out-of-range date stays unreadable
                        value = None
                elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                    value = bool(value)
                elif cell.ctype == xlrd.XL_CELL_NUMBER and float(value).is_integer():
                    value = int(value)
                fmt, bold = "General", False
                try:
                    xf = book.xf_list[cell.xf_index]
                    fmt = book.format_map[xf.format_key].format_str
                    bold = bool(book.font_list[xf.font_index].bold) and value is not None
                except (IndexError, KeyError, AttributeError):
                    pass
                cells.append(Cell(value, fmt, bold))
            rows.append(cells)
        sheets.append(Sheet(sheet.name, _pad(rows), sheet.nrows > MAX_ROWS))
    return sheets


def decode_csv(data: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def sniff_delimiter(text: str) -> str:
    sample = text[:16384]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=";,\t|")
        # The Sniffer likes commas inside German decimals; trust it only if the lines agree on the count.
        counts = {line.count(dialect.delimiter) for line in sample.splitlines()[1:12] if line.strip()}
        if len(counts) <= 2 and sample.count(dialect.delimiter) > 0:
            return dialect.delimiter
    except csv.Error:
        pass
    return ";"


def load_csv(data: bytes) -> list[Sheet]:
    text = decode_csv(data)
    reader = csv.reader(StringIO(text, newline=""), delimiter=sniff_delimiter(text))
    rows = []
    for index, record in enumerate(reader):
        if index >= MAX_ROWS:
            break
        rows.append([Cell(value.strip() or None) if isinstance(value, str) else Cell() for value in record])
    while rows and all(c.value is None for c in rows[-1]):
        rows.pop()
    return [Sheet("csv", _pad(rows))]


def load_sheets(data: bytes, fmt: str) -> list[Sheet]:
    if fmt == "xlsx":
        return load_xlsx(data)
    if fmt == "xls":
        return load_xls(data)
    if fmt == "csv":
        return load_csv(data)
    raise ValueError(f"Not a spreadsheet format: {fmt}")


# --------------------------------------------------------------------------- cell helpers


def col_letter(index: int) -> str:
    letters, number = "", index + 1
    while number:
        number, remainder = divmod(number - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def col_index(ref) -> int:
    """'A' / 'aa' / 3 / '3' -> zero-based column index (numbers are one-based, as Excel shows them)."""
    if isinstance(ref, bool):
        raise ValueError(f"Not a column reference: {ref!r}")
    if isinstance(ref, int) or (isinstance(ref, str) and ref.strip().isdigit()):
        number = int(ref)
        if number < 1:
            raise ValueError(f"Column numbers start at 1, got {ref!r}")
        return number - 1
    if isinstance(ref, str) and re.fullmatch(r"[A-Za-z]{1,3}", ref.strip()):
        index = 0
        for char in ref.strip().upper():
            index = index * 26 + ord(char) - 64
        return index - 1
    raise ValueError(f"Not a column reference: {ref!r}")


def text_of(cell: Cell | None) -> str | None:
    if cell is None or cell.value is None or isinstance(cell.value, (bool, date, datetime)):
        return None
    value = cell.value if isinstance(cell.value, str) else num_text(cell.value)
    if value is None:
        return None
    value = value.replace("\xa0", " ").strip()
    return value or None


def num_text(value) -> str | None:
    """A plain decimal string for a number cell, without float noise (0.1+0.2 -> 0.3)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value)
    try:
        number = Decimal(repr(value) if isinstance(value, float) else str(value))
    except InvalidOperation:
        return None
    if not number.is_finite():
        return None
    if -number.as_tuple().exponent > 10:
        number = round(number, 10)
    text = format(number, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text in {"-0", ""} else text


def normalise_header(text: str) -> str:
    folded = text.casefold()
    for source, target in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        folded = folded.replace(source, target)
    tokens = [t for t in re.findall(r"[a-z0-9]+", folded) if t not in _NOISE]
    return "".join(tokens)


def match_field(text: str | None) -> str | None:
    return _LOOKUP.get(normalise_header(text)) if text else None


def to_amount(cell: Cell | None) -> tuple[str | None, str | None, str | None]:
    """(number as decimal text, raw text, split-off unit) of a quantity or price cell."""
    if cell is None or cell.value is None:
        return None, None, None
    value = cell.value
    if isinstance(value, bool):
        return None, str(value), None
    if isinstance(value, (date, datetime)):
        return None, value.isoformat(), None
    if not isinstance(value, str):
        text = num_text(value)
        return text, text, None
    raw = value.replace("\xa0", " ").replace(" ", " ").strip()
    if not raw:
        return None, None, None
    cleaned = re.sub(r"\s*(?:€|EUR|Euro)\s*$", "", raw, flags=re.I).replace(" ", "") if re.search(r"\d", raw) else raw
    number = german_decimal(cleaned)
    if number is None and re.fullmatch(r"[+-]?\d+\.\d+", cleaned):
        number = cleaned
    if number is not None:
        return number, raw, None
    # "12,5 m2": a quantity with its unit in one cell
    match = re.fullmatch(rf"({NUMBER}|[+-]?\d+\.\d+)\s*(\S+)", raw)
    if match and UNIT.fullmatch(match[2]):
        return german_decimal(match[1]) or match[1], raw, match[2]
    return None, raw, None


CODE_RE = re.compile(r"^(?:\d+[A-Za-z]?(?:[.\-/]\d+[A-Za-z]?)*(?:\.[A-Za-z])?\.?|\.\d+)$")
CODE_WITH_TEXT = re.compile(r"^(\d+(?:\.\d+)*\.?)\s+(\S.*)$", re.S)
SECTION_LABEL = re.compile(r"^(?:Titel|Los|Abschnitt|Bereich|Gewerk|Leistungsbereich)\s+(\d+(?:\.\d+)*)\.?\s*[:\-–—]?\s*(.*)$",
                           re.I | re.S)
TOTAL_LABEL = re.compile(
    r"^\s*(?:(?:zwischen|gesamt|netto|brutto|end|angebots|auftrags)[\s-]*)?(?:summe|betrag)\b"
    r"|^\s*(?:gesamt\w*|übertrag|uebertrag|mwst|ust|mehrwertsteuer|zzgl|nachlass|skonto|rabatt|angebotssumme|nettosumme)\b",
    re.I)
NET_LABEL = re.compile(r"(?:gesamt|netto|angebot|end)", re.I)
NOT_NET_LABEL = re.compile(r"(?:mwst|ust|mehrwert|brutto|zzgl|übertrag|uebertrag|nachlass|skonto|rabatt)", re.I)
DOTS_ONLY = re.compile(r"^[.…]{2,}$")


def numeric_code(value, fmt: str) -> tuple[str | None, bool]:
    """Rebuild an OZ stored as a number from its number format (1.001 with 00.0000 -> '01.0010').

    Returns (code, exact). ``exact`` is False when the format said nothing and leading zeros may be lost.
    """
    if isinstance(value, bool):
        return None, False
    first = (fmt or "General").split(";")[0]
    literal_dots = "\\." in first or '"."' in first
    mask = re.sub(r'\[[^\]]*\]|["\\_*]', "", first)
    zeros = [g.count("0") for g in mask.split(".")]
    integral = float(value).is_integer()
    if re.fullmatch(r"[0#?]+(?:\.[0#?]+)+", mask) and (literal_dots or len(zeros) > 2) and integral:
        digits = str(int(abs(value))).zfill(sum(zeros))
        parts, end = [], len(digits)
        for width in reversed(zeros[1:]):
            parts.append(digits[end - width:end] if width else "")
            end -= width
        parts.append(digits[:end])
        return ".".join(reversed(parts)), True
    if re.fullmatch(r"[0#?]+\.[0#?]+", mask):
        decimals = len(mask.split(".")[1])
        number = Decimal(repr(float(value))).quantize(Decimal(1).scaleb(-decimals))
        whole, _, fraction = format(number, "f").partition(".")
        return f"{whole.zfill(zeros[0])}.{fraction}", True
    if re.fullmatch(r"0+", mask) and integral:
        return str(int(value)).zfill(len(mask)), True
    text = num_text(value)
    return text, integral


POSITION_TYPES = [
    # (matcher on the normalised value, kind)
    (re.compile(r"^(?:titel|los|abschnitt|gewerk|t|l)$"), "section"),
    (re.compile(r"^(?:n|normal\w*|np)$"), "normal"),
    (re.compile(r"^(?:g|grund\w*|gp)$"), "base"),
    (re.compile(r"^(?:w|a|wahl\w*|alt\w*|ap)$"), "alternative"),
    (re.compile(r"^(?:b|e|bp|bedarf\w*|eventual\w*|ev)$"), "provisional"),
]


def classify_position_type(raw: str | None) -> tuple[str | None, dict]:
    """(kind, GAEB-style flags) for a Pos.-Art cell. Unknown values give (None, {})."""
    if not raw:
        return "normal", {}
    value = re.sub(r"[^a-zäöüß]", "", raw.casefold())
    kind = next((name for pattern, name in POSITION_TYPES if pattern.fullmatch(value)), None)
    lowered = raw.casefold()
    if kind == "base":
        return kind, {"position_type": "G"}
    if kind == "alternative":
        return kind, {"position_type": "A"}
    if kind == "provisional":
        # Bedarfs-/Eventualposition without a total unless the text says it is part of it.
        if "mit gb" in lowered or "mit gesamt" in lowered:
            return kind, {"Provis": "WithTotal"}
        return kind, {"provisional_flag": "E"}
    if kind == "normal":
        return kind, {"position_type": "N"}
    return kind, {}


# --------------------------------------------------------------------------- header detection


def _row_texts(row: list[Cell]) -> list[str | None]:
    return [text_of(cell) if isinstance(cell.value, str) else None for cell in row]


def detect_fields(rows: list[list[Cell]], index: int, span: int) -> tuple[dict[str, int], int]:
    """Map fields to columns for a header that starts at ``rows[index]`` and spans one or two rows."""
    top = _row_texts(rows[index])
    bottom = _row_texts(rows[index + 1]) if span == 2 and index + 1 < len(rows) else [None] * len(top)
    if span == 2 and (
        index + 1 >= len(rows)
        or any(t and CODE_RE.fullmatch(t) for t in top + bottom)  # a data row, not a header
        or not any(match_field(t) for t in top)  # a title row above a one-row header
    ):
        return {}, 0
    columns: dict[str, int] = {}
    for column in range(len(top)):
        options = [top[column]] if span == 1 else [
            " ".join(t for t in (top[column], bottom[column]) if t) if top[column] and bottom[column] else None,
            bottom[column], top[column],
        ]
        for option in options:
            field = match_field(option)
            if field and field not in columns:
                columns[field] = column
                break
    return columns, sum(WEIGHTS[field] for field in columns)


def acceptable(columns: dict[str, int], score: int) -> bool:
    return bool("code" in columns and ("quantity" in columns or "short_text" in columns) and score >= HEADER_MIN_SCORE)


def detect_header(rows: list[list[Cell]]) -> dict | None:
    best = None
    for index in range(min(len(rows), HEADER_SCAN_ROWS)):
        for span in (1, 2):
            columns, score = detect_fields(rows, index, span)
            if not acceptable(columns, score):
                continue
            if best is None or score > best["score"] or (score == best["score"] and span < best["span"]):
                best = {"row": index, "span": span, "columns": columns, "score": score}
    if best:
        best["confidence"] = round(min(1.0, best["score"] / FULL_SCORE), 2)
    return best


def validate_mapping(mapping) -> dict:
    """Check a user-supplied column map: {"code": "A", "short_text": "C", ..., "header_row": 6, "sheet": "LV"}."""
    if not isinstance(mapping, dict):
        raise ValueError("column_map must be a JSON object such as {\"code\": \"A\", \"quantity\": \"E\"}")
    unknown = set(mapping) - set(FIELDS) - {"header_row", "sheet"}
    if unknown:
        raise ValueError(f"Unknown column_map keys: {', '.join(sorted(unknown))}. Use {', '.join(FIELDS)}, header_row, sheet")
    if "code" not in mapping or not ({"quantity", "short_text"} & set(mapping)):
        raise ValueError("column_map needs at least \"code\" and one of \"quantity\" or \"short_text\"")
    columns = {field: col_index(ref) for field, ref in mapping.items() if field in FIELDS}
    if len(set(columns.values())) != len(columns):
        raise ValueError("column_map assigns one column to two fields")
    header_row = mapping.get("header_row", 0)
    if isinstance(header_row, bool) or not isinstance(header_row, int) or header_row < 0:
        raise ValueError("header_row must be a row number (1 = first row) or 0 for no header")
    if "sheet" in mapping and not isinstance(mapping["sheet"], str):
        raise ValueError("sheet must be a sheet name")
    return {"columns": columns, "header_row": header_row, "sheet": mapping.get("sheet")}


# --------------------------------------------------------------------------- the parser


def excel(data: bytes, fmt: str, mapping: dict | None = None) -> Result:
    result = Result(fmt)
    override = validate_mapping(mapping) if mapping else None
    sheets = load_sheets(data, fmt)
    result.metadata["sheets"] = [sheet.name for sheet in sheets]
    result.metadata["column_map"] = {}
    boq_index = 0
    for sheet in sheets:
        if sheet.truncated:
            result.warn("excel_sheet_truncated", {"sheet": sheet.name}, f"Only the first {MAX_ROWS} rows were read")
        header = None
        if override and override["sheet"] in (None, sheet.name):
            header_row = override["header_row"]
            header = {"row": header_row - 1 if header_row else -1, "span": 1, "columns": override["columns"],
                      "score": FULL_SCORE, "confidence": 1.0, "override": True}
        else:
            header = detect_header(sheet.rows)
        if header is None:
            if sheet.rows:
                result.warn("excel_sheet_skipped", {"sheet": sheet.name},
                            "No header row with a position number and a quantity or short text was found")
            continue
        boq_index += 1
        SheetParser(sheet, header, boq_index, result).run()
    if not boq_index:
        result.warn("excel_no_header", {"part": "document"},
                    "No sheet has a recognisable header (position number plus quantity or short text). "
                    "Pass a column map such as {\"code\": \"A\", \"short_text\": \"B\", \"quantity\": \"C\", \"unit\": \"D\"}")
    if not any(record.kind == "item_candidate" for record in result.records):
        result.warn("no_boq_items", {"part": "document"}, "No BoQ positions were found in the spreadsheet")
    return result


class SheetParser:
    def __init__(self, sheet: Sheet, header: dict, boq_index: int, result: Result):
        self.sheet, self.header, self.boq_index, self.result = sheet, header, boq_index, result
        self.columns: dict[str, int] = header["columns"]
        self.base = {"boq_index": boq_index, "sheet": sheet.name}
        self.current: dict | None = None
        self.section_paths: list[str] = []
        self.sections_seen: set[tuple] = set()
        self.section_codes: set[str] = set()
        self.warned: set[str] = set()
        self.uncached = 0

    # -- plumbing

    def locator(self, row: int, **extra) -> dict:
        return {"sheet": self.sheet.name, "row": row, "record": f"{self.sheet.name}!{row}", **extra}

    def warn_once(self, code: str, key: str, locator: dict, detail: str) -> None:
        if (code, key) not in self.warned:
            self.warned.add((code, key))
            self.result.warn(code, locator, detail)

    def cell(self, row: list[Cell], field: str) -> Cell | None:
        column = self.columns.get(field)
        return row[column] if column is not None and column < len(row) else None

    def run(self) -> None:
        header, result, sheet = self.header, self.result, self.sheet
        letters = {field: col_letter(column) for field, column in self.columns.items()}
        first = header["row"] + header["span"] if header["row"] >= 0 else 0
        title = next((t for row in sheet.rows[:max(header["row"], 0)] for t in _row_texts(row) if t), None)
        result.metadata["column_map"][sheet.name] = {**letters, "header_row": header["row"] + 1,
                                                     "confidence": header["confidence"]}
        result.add("boq_header", self.locator(header["row"] + 1 if header["row"] >= 0 else 1),
                   boq_index=self.boq_index, boq_code=sheet.name, boq_title=title or sheet.name,
                   sheet=sheet.name, column_map=letters, header_row=header["row"] + 1, confidence=header["confidence"])
        if header["confidence"] < REVIEW_CONFIDENCE:
            result.warn("excel_mapping_review", {"sheet": sheet.name, "row": header["row"] + 1},
                        f"Column mapping is a weak match ({header['confidence']}): "
                        + ", ".join(f"{field}={letter}" for field, letter in letters.items()))
        if self.columns.get("unit_price") is not None or self.columns.get("line_amount") is not None:
            header_text = " ".join(t for row in sheet.rows[max(header["row"], 0):first] for t in _row_texts(row) if t)
            if re.search(r"€|eur", header_text, re.I):
                result.metadata.setdefault("currency", "EUR")

        rows = sheet.rows
        item_depth = self.item_depth(rows[first:])
        skip_until = first
        for index in range(first, len(rows)):
            row = rows[index]
            if index < skip_until:
                continue
            row_number = index + 1
            self.note_uncached(row, row_number)
            if all(c.value is None for c in row):
                continue
            span = self.repeated_header(index)
            if span:
                self.flush()
                skip_until = index + span
                continue
            self.handle_row(row, row_number, item_depth)
        self.flush()
        if self.uncached:
            result.warn("excel_formula_uncached", {"sheet": sheet.name},
                        f"{self.uncached} formula cells have no saved result (open and save the file in Excel); "
                        "their values are treated as missing")

    # -- header repeats and uncached formulas

    def repeated_header(self, index: int) -> int:
        rows, span = self.sheet.rows, self.header["span"]
        if self.header.get("override") and self.header["row"] < 0:
            return 0
        for width in {span, 1}:
            columns, score = detect_fields(rows, index, width)
            if acceptable(columns, score) and score >= max(HEADER_MIN_SCORE, 0.6 * self.header["score"]):
                return width
        return 0

    def note_uncached(self, row: list[Cell], row_number: int) -> None:
        for field, column in self.columns.items():
            if column < len(row) and row[column].uncached:
                self.uncached += 1
                if self.uncached <= 20:
                    self.result.warn("excel_formula_uncached", self.locator(row_number, cell=f"{col_letter(column)}{row_number}"),
                                     f"Formula in {field} has no saved result")

    # -- structure

    def item_depth(self, rows: list[list[Cell]]) -> int | None:
        depths, deepest = [], 0
        for row in rows:
            code, _ = self.read_code(row, quiet=True)
            if not code:
                continue
            parts = len([p for p in code.rstrip(".").split(".") if p])
            deepest = max(deepest, parts)
            if any(text_of(self.cell(row, f)) for f in ("quantity", "unit", "unit_price", "line_amount")):
                depths.append(parts)
        if depths:
            return max(set(depths), key=lambda d: (depths.count(d), d))
        return deepest or None

    def read_code(self, row: list[Cell], quiet: bool = False) -> tuple[str | None, str | None]:
        """(code, text left over when the code cell held 'code text' or a section label)."""
        cell = self.cell(row, "code")
        if cell is None or cell.value is None:
            return None, None
        value = cell.value
        if isinstance(value, (datetime, date)):
            if not quiet:
                self.warn_once("excel_code_date", "date", {"sheet": self.sheet.name},
                               "Excel turned a position number such as 1.10 into a date; it was converted back to day.month. "
                               "Format the OZ column as text")
            return f"{value.day}.{value.month}", None
        if isinstance(value, bool):
            return None, None
        if not isinstance(value, str):
            code, exact = numeric_code(value, cell.fmt)
            if code and not exact and not quiet:
                self.warn_once("excel_code_numeric", "numeric", {"sheet": self.sheet.name},
                               f"Position number {code!r} is stored as a number without a number format; "
                               "trailing zeros (01.0010) may be lost. Format the OZ column as text")
            return code, None
        text = " ".join(value.replace("\xa0", " ").split())
        if not text:
            return None, None
        if CODE_RE.fullmatch(text):
            return text, None
        label = SECTION_LABEL.match(value.strip())
        if label:
            return label[1], label[2].strip() or None
        merged = CODE_WITH_TEXT.match(text)
        if merged:
            return merged[1], merged[2]
        return None, text

    def handle_row(self, row: list[Cell], row_number: int, item_depth: int | None) -> None:
        code, leftover = self.read_code(row)
        section_col = text_of(self.cell(row, "section_code"))
        if code and section_col and "." not in code and section_col.rstrip(".") != code:
            code = f"{section_col.rstrip('.')}.{code}"
        short = text_of(self.cell(row, "short_text")) or leftover
        long = text_of(self.cell(row, "long_text"))
        qty_cell, unit_cell = self.cell(row, "quantity"), self.cell(row, "unit")
        price_cell, amount_cell = self.cell(row, "unit_price"), self.cell(row, "line_amount")
        type_raw = text_of(self.cell(row, "position_type"))
        has_amounts = any(text_of(c) or (c is not None and c.value is not None and not isinstance(c.value, str))
                          for c in (qty_cell, unit_cell, price_cell, amount_cell))
        bold = self.row_bold(row)

        # Printed totals: Summe / Übertrag / MwSt rows without a position number
        label = short or long or self.free_text(row)
        if not code and label and TOTAL_LABEL.match(label) and self.read_total(row, row_number, label):
            return

        kind, flags = classify_position_type(type_raw)
        if not code and section_col and not has_amounts:
            code = section_col  # a title row of a sheet that has a separate Titel/Los column
            kind = "section"
        if type_raw and kind is None:
            self.warn_once("excel_position_type_unknown", type_raw.casefold(), self.locator(row_number),
                           f"Unknown Pos.-Art value {type_raw!r}; the position is treated as a normal one")

        if code:
            depth = len([p for p in code.rstrip(".").split(".") if p])
            labelled = kind == "section" or bool(leftover and SECTION_LABEL.match(text_of(self.cell(row, "code")) or ""))
            is_section = not has_amounts and (labelled or bold or (item_depth is not None and depth < item_depth))
            if is_section:
                self.flush()
                self.section_row(code, short or long or "", self.locator(row_number))
                return
            self.flush()
            self.current = {
                "locator": self.locator(row_number, end_row=row_number), "code": code,
                "section_path": list(self.section_paths), "short": short,
                "long": [long] if long else [], "qty": qty_cell, "unit": unit_cell, "price": price_cell,
                "amount": amount_cell, "has_amounts": has_amounts, "flags": flags, "kind": kind,
            }
            return

        # No position number: a continuation of the current item, or a note
        text = long or short or self.free_text(row)
        if self.current is None:
            if text:
                self.result.add("note", self.locator(row_number), **self.base, section_path=self.section_paths[-1] if self.section_paths else None, text=text)
            return
        if has_amounts:
            current = self.current
            if not current["has_amounts"]:
                current.update(qty=qty_cell, unit=unit_cell, price=price_cell, amount=amount_cell, has_amounts=True)
            else:
                self.result.warn("excel_orphan_amounts", self.locator(row_number),
                                 f"Amounts on a row without a position number were ignored; the previous item {current['code']} already has amounts")
        if text:
            self.current["long"].append(text)
        self.current["locator"]["end_row"] = row_number

    def free_text(self, row: list[Cell]) -> str | None:
        """The first text cell that is not a number/unit/price/code column."""
        taken = {self.columns[f] for f in ("code", "quantity", "unit", "unit_price", "line_amount", "position_type",
                                           "section_code") if f in self.columns}
        return next((t for column, t in enumerate(_row_texts(row)) if t and column not in taken), None)

    def row_bold(self, row: list[Cell]) -> bool:
        filled = [c for c in row if c.value is not None]
        return bool(filled) and all(c.bold for c in filled)

    # -- records

    def section_row(self, code: str, label: str, locator: dict) -> None:
        depth = len(code.rstrip(".").split("."))
        del self.section_paths[depth - 1:]
        if len(self.section_paths) < depth - 1:
            parts = code.rstrip(".").split(".")
            self.section_paths.extend([".".join(parts[:d]) for d in range(1, depth)][len(self.section_paths):])
        self.section_paths.append(code)
        key = tuple(self.section_paths)
        if key in self.sections_seen:
            return
        self.sections_seen.add(key)
        self.section_codes.add(code.rstrip("."))
        self.result.add("section_candidate", locator, **self.base, code=code, label=label.strip(),
                        section_path=self.section_paths[:-1])

    def read_total(self, row: list[Cell], row_number: int, label: str) -> bool:
        amount_cell = self.cell(row, "line_amount")
        number, raw, _ = to_amount(amount_cell)
        if number is None:
            code_column = self.columns.get("code")
            for column, cell in reversed(list(enumerate(row))):
                number, raw, _ = to_amount(cell) if column != code_column else (None, None, None)
                if number is not None:
                    break
        if number is None:
            return False
        self.flush()
        locator = self.locator(row_number)
        self.result.add("reported_amount", locator, **self.base, label=label.strip(), amount_raw=raw, amount=number)
        match = re.search(r"\b(\d+(?:\.\d+)*)\b", label)
        code = match[1] if match and match[1] in self.section_codes else None
        if code is None and re.match(r"\s*(?:zwischen)?summe\b", label, re.I) and not match and self.section_paths:
            code = self.section_paths[-1].rstrip(".")
        if code and re.match(r"\s*(?:zwischen)?summe\b", label, re.I):
            self.result.add("subtotal", locator, **self.base, code_parts=[p for p in code.split(".") if p],
                            reported_amount=number, discounted_amount=None, lump_sum_amount=None)
        elif NET_LABEL.search(label) and not NOT_NET_LABEL.search(label) and code is None:
            self.result.add("summary", locator, **self.base, net_total=number)
        return True

    def flush(self) -> None:
        item = self.current
        if item is None:
            return
        self.current = None
        quantity, quantity_raw, split_unit = to_amount(item["qty"])
        unit = text_of(item["unit"]) or split_unit
        price_only = False
        prices = {}
        for key in ("price", "amount"):
            cell = item[key]
            number, raw, _ = to_amount(cell)
            if raw and (PRICE_ONLY.search(raw) or DOTS_ONLY.fullmatch(raw)):
                price_only = True
            prices[key] = number
        short = item["short"]
        long = "\n".join(item["long"]).strip() or None
        flags = dict(item["flags"])
        marker = item_flags(f"{short or ''}\n{long or ''}")
        marker["unit_price_only"] = marker["unit_price_only"] or price_only
        flags.update({key: True for key, value in marker.items() if value})
        locator = item["locator"]
        if not item["has_amounts"]:
            self.result.warn("excel_quantity_review", {**locator, "code": item["code"]},
                             "No quantity, unit or price on this row; review the source")
        elif quantity_raw is not None and quantity is None:
            self.result.warn("excel_quantity_unreadable", {**locator, "code": item["code"]},
                             f"Cannot read quantity {quantity_raw!r}")
        self.result.add("item_candidate", locator, **self.base, code=item["code"], section_path=item["section_path"],
                        short_description=short, long_description=long, quantity_raw=quantity_raw,
                        quantity=quantity, unit=unit, unit_price=prices["price"], line_amount=prices["amount"],
                        flags=flags, confidence="review")
