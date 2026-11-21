"""Exercise every file in the repository's tender and public fixture datasets."""

from collections import Counter
from hashlib import sha256
from io import BytesIO
from pathlib import Path

import pytest
from lxml import etree
from pypdf import PdfReader

from tender_import.common import detect_format
from tender_import.ingest import parse_document


ROOT = Path(__file__).resolve().parents[3]
PUBLIC = ROOT / "data" / "fixtures"
METADATA = {"README.md", "MANIFEST.sha256", ".gitattributes"}
FILES = sorted(path for folder in (ROOT / "data" / "tenders", PUBLIC) for path in folder.rglob("*")
               if path.is_file() and path.name not in METADATA)
UNSUPPORTED = {".p86", ".x83z", ".x84z", ".x86ze", ".x86zr"}


def test_public_manifest_covers_and_matches_all_fixtures():
    manifest = dict(line.split(" *", 1)[::-1] for line in (PUBLIC / "MANIFEST.sha256").read_text().splitlines())
    paths = {path.relative_to(PUBLIC).as_posix(): path for path in FILES if path.is_relative_to(PUBLIC)}
    assert set(manifest) == set(paths)
    for name, path in paths.items():
        assert sha256(path.read_bytes()).hexdigest() == manifest[name], name


@pytest.mark.parametrize("path", FILES, ids=lambda path: str(path.relative_to(ROOT)))
def test_dataset_file(path):
    data = path.read_bytes()
    kind = detect_format(path.name, data)
    ext = path.suffix.lower()
    if ext in UNSUPPORTED:
        assert kind == "unsupported"
        with pytest.raises(ValueError, match="Unsupported file type"):
            parse_document(kind, data, None)
        return

    result = parse_document(kind, data, None)
    assert result.format == kind
    records = Counter(record.kind for record in result.records)

    if ext.startswith(".x"):
        assert kind == "gaeb_xml" and result.phase == ext[2:]
        source = etree.fromstring(data)
        positions = source.xpath(".//*[local-name()='Item' or local-name()='MarkupItem']")
        assert records["item"] == len(positions) > 0
        assert records["xml_document"] == 1
    elif ext.startswith(".d") and ext != ".docx":
        assert kind == "gaeb_1990" and result.phase == ext[2:]
        source = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n").split(b"\n")
        raw_records = Counter(line[:2] for line in source)
        assert records["item"] == raw_records[b"21"]
        assert records["price"] == raw_records[b"22"] + raw_records[b"23"]
        assert records["item"] or records["price"]
    elif ext == ".pdf":
        assert kind == "pdf"
        assert records["pdf_page"] == len(PdfReader(BytesIO(data)).pages) > 0
        assert any(record.payload["layout"].strip() for record in result.records if record.kind == "pdf_page")
        if path.is_relative_to(ROOT / "data" / "tenders"):
            assert records["item_candidate"] > 0
    else:
        assert ext == ".docx" and kind == "docx"
        assert records["paragraph"] > 0
        assert records["item_candidate"] == 40
