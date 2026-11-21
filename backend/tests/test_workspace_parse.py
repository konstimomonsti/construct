from pathlib import Path

import pytest

from analysis import adapter
from analysis.runner import analyze
from tender_import.pdf import check_poppler
from workspace_analysis import _attach_source, _uploaded_input
from workspace_parse import preview, read_document

DATA = Path(__file__).resolve().parents[2] / "data" / "tenders"


def test_precast_pdf_preview_and_assessment():
    try:
        check_poppler()
    except (OSError, ValueError) as exc:
        pytest.skip(str(exc))
    pdf = DATA / "LV_11_Stahlbetonfertigeile_Sandwichsockel.pdf"
    content = pdf.read_bytes()
    result = preview(pdf.name, content)
    assert [row["oz"].rstrip(".") for row in result["positions"]] == [f"3.2.{n}" for n in range(10, 100, 10)]
    assert [(row["qty"], row["unit"]) for row in result["positions"][-3:]] == [(0.7, "TO"), (1, "m"), (15, "St")]
    document = {**result, "fileName": pdf.name, "source": {"kind": "pdf"}}
    uploaded = _uploaded_input(document)
    snapshot = adapter.from_data(uploaded["snapshot"])
    original = read_document(pdf.name, content).snapshots[0]
    assert _attach_source(snapshot, original, uploaded["original_codes"])
    assert all(line.source_locator.get("page") for line in snapshot.lines)
    report = analyze(snapshot, [1, 2])
    assert report.findings and report.risk and report.questions
    assert not report.errors


def test_parse_rejects_unsupported_or_invalid_uploads():
    with pytest.raises(ValueError, match="PDF or"):
        preview("example.csv", b"arbitrary")
    with pytest.raises(ValueError, match="valid PDF"):
        preview("example.pdf", b"not a PDF")
    with pytest.raises(ValueError, match="97–2003"):
        preview("example.xls", b"not an Excel workbook")
