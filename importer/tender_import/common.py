from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from hashlib import sha256
from pathlib import PurePosixPath
import re
from zipfile import ZipFile, ZipInfo

from lxml import etree

MAX_FILE_BYTES = 128 * 1024 * 1024
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 5000
PARSER_VERSION = "1.0.2"


@dataclass
class Extract:
    kind: str
    locator: dict
    payload: dict


@dataclass
class Result:
    format: str
    version: str | None = None
    phase: str | None = None
    metadata: dict = field(default_factory=dict)
    records: list[Extract] = field(default_factory=list)
    issues: list[dict] = field(default_factory=list)
    needs_review: bool = False

    def add(self, kind: str, locator: dict, **payload) -> None:
        self.records.append(Extract(kind, locator, payload))

    def warn(self, code: str, locator: dict, detail: str) -> None:
        self.issues.append({"code": code, "locator": locator, "detail": detail})
        self.needs_review = True


def detect_format(name: str, content: bytes) -> str:
    extension = PurePosixPath(name).suffix.lower()
    if content.lstrip()[:5] == b"%PDF-" or extension == ".pdf":
        return "pdf"
    if extension == ".docx":
        return "docx"
    if extension == ".zip":
        return "zip"
    if extension in {".xlsx", ".xlsm"}:
        return "xlsx"
    if extension == ".xls":
        return "xls"
    if extension in {".csv", ".tsv"}:
        return "csv"
    if re.fullmatch(r"\.x\d{2}", extension) or extension == ".xml":
        return "gaeb_xml"
    if re.fullmatch(r"\.d\d{2}", extension):
        return "gaeb_1990"
    return "unsupported"


# Regexes shared by the PDF and spreadsheet parsers. pdf.py still carries its own copies of these;
# it can switch to the ones below once the PDF fixes have landed.
NUMBER = r"[+\-−]?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?"
UNIT = re.compile(r"^(?:m(?:[²³23])?(?:wo|d)?|cm[²23]?|mm|km[²2]?|kg|t|to|l|kwh|st(?:k|ck)?\.?|stwo|satz|set|pau|psch\.?|h|std\.?|wo\.?|mt\.?|mo\.?|d|j(?:r|ahre?)|lfm)$", re.I)
PRICE_ONLY = re.compile(r"nur\s+(?:einh[. -]*pr\.?|einheitspreis|EP)\b", re.I)


def item_flags(description: str) -> dict:
    """Marker words in the printed text ("Bedarfsposition ohne GB") that change how a line is totalled."""
    lowered = description.casefold()
    return {
        "unit_price_only": bool(PRICE_ONLY.search(description)) or "ohne gb" in lowered or "ohne gesamtbetrag" in lowered,
        "provisional_included": "bedarfsposition mit gb" in lowered,
        "base_item": "grundposition" in lowered,
        "alternative_item": "wahlposition" in lowered or "alternativposition" in lowered,
    }


def german_decimal(raw: str) -> str | None:
    value = raw.strip().replace("−", "-")
    if not re.fullmatch(r"[+-]?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?", value):
        return None
    return str(Decimal(value.replace(".", "").replace(",", ".")))


def decimal_text(raw: str | None) -> str | None:
    if raw is None:
        return None
    try:
        value = Decimal(raw.strip())
        return str(value) if value.is_finite() else None
    except InvalidOperation:
        return None


def parse_xml(data: bytes, *, generated: bool = False) -> etree._Element:
    parser = etree.XMLParser(no_network=True, resolve_entities=False, load_dtd=False)
    root = etree.fromstring(data, parser)
    if root.getroottree().docinfo.doctype and not generated:
        raise ValueError("A source XML document may not declare a DTD")
    return root


def local_name(node: etree._Element) -> str:
    return etree.QName(node).localname if isinstance(node.tag, str) else ""


def xml_element(node: etree._Element) -> dict:
    if isinstance(node, etree._Comment):
        return {"kind": "comment", "text": node.text, "tail": node.tail}
    if isinstance(node, etree._ProcessingInstruction):
        return {"kind": "processing_instruction", "target": node.target, "text": node.text, "tail": node.tail}
    return {
        "tag": node.tag,
        "prefix": node.prefix,
        "attributes": dict(node.attrib),
        "text": node.text,
        "tail": node.tail,
        "children": [xml_element(child) for child in node],
    }


def xml_document(root: etree._Element) -> dict:
    before, after = [], []
    for sibling in root.itersiblings(preceding=True):
        before.append(xml_element(sibling))
    for sibling in root.itersiblings():
        after.append(xml_element(sibling))
    info = root.getroottree().docinfo
    # Declarations, lexical prefixes, CDATA and entity spellings also remain in the original bytes.
    declarations = [
        {"path": node.getroottree().getelementpath(node), "namespace_map": {key or "": value for key, value in node.nsmap.items()}}
        for node in root.iter()
        if isinstance(node.tag, str) and node.nsmap != (node.getparent().nsmap if node.getparent() is not None else {})
    ]
    return {
        "encoding": info.encoding,
        "xml_version": info.xml_version,
        "namespace_declarations": declarations,
        "before_root": list(reversed(before)),
        "root": xml_element(root),
        "after_root": after,
    }


def checked_entries(archive: ZipFile) -> list[ZipInfo]:
    entries = archive.infolist()
    if len(entries) > MAX_ARCHIVE_ENTRIES:
        raise ValueError(f"Archive exceeds {MAX_ARCHIVE_ENTRIES} entries")
    if sum(entry.file_size for entry in entries) > MAX_ARCHIVE_BYTES:
        raise ValueError("Archive exceeds the expanded size limit")
    return entries


def read_member(archive: ZipFile, entry: ZipInfo) -> bytes:
    if entry.file_size > MAX_FILE_BYTES:
        raise ValueError("Member exceeds the per-file size limit")
    with archive.open(entry) as stream:
        data = stream.read(MAX_FILE_BYTES + 1)
    if len(data) != entry.file_size or len(data) > MAX_FILE_BYTES:
        raise ValueError("Archive member size does not match its directory entry")
    return data


def zip_metadata(entry: ZipInfo, data: bytes | None = None) -> dict:
    return {
        "path": entry.filename,
        "directory": entry.is_dir(),
        "uncompressed_bytes": entry.file_size,
        "compressed_bytes": entry.compress_size,
        "crc32": f"{entry.CRC:08x}",
        "modified": list(entry.date_time),
        "compression_method": entry.compress_type,
        "flags": entry.flag_bits,
        "sha256": sha256(data).hexdigest() if data is not None else None,
    }
