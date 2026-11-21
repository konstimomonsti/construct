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
    with pytest.raises(ValueError, match="readable Word"):
        preview("example.docx", b"not a Word document")
    with pytest.raises(ValueError, match="97–2003"):
        preview("example.xls", b"not an Excel workbook")


def test_plain_word_positions_have_paragraph_locators():
    word = DATA / "LV-Positionen.docx"
    content = word.read_bytes()
    snapshot = read_document(word.name, content).snapshots[0]
    result = preview(word.name, content)
    assert len(result["positions"]) == len(snapshot.lines) == 40
    assert [position["id"] for position in result["positions"]] == [line.id for line in snapshot.lines]
    assert snapshot.lines[0].source_locator["paragraph"] == 2
    assert snapshot.lines[0].quantity is None


@pytest.mark.parametrize(("suffix", "locator"), [("docx", {"table": 1, "row": 2}), ("pdf", {"page": 1})])
def test_native_document_upload_preserves_written_amount_and_locator(tmp_path, monkeypatch, suffix, locator):
    if suffix == "pdf":
        try:
            check_poppler()
        except (OSError, ValueError) as exc:
            pytest.skip(str(exc))
    from analysis.eval.documents import Item, pdf_file, word_file
    import workspace_analysis

    path = tmp_path / f"written-amount.{suffix}"
    writer = pdf_file if suffix == "pdf" else word_file
    writer(path, [Item("02.0010", "Leerrohre für Signaltechnik liefern", 5, "m", amount=85)])
    data = path.read_bytes()
    source = read_document(path.name, data).snapshots[0]
    result = preview(path.name, data)
    document = {**result, "fileName": path.name, "source": {"kind": suffix}}
    monkeypatch.setenv("ANALYSIS_L3_PROVIDER", "none")
    monkeypatch.setattr(workspace_analysis, "_source", lambda *_: source)
    report = workspace_analysis.run(_uploaded_input(document), object(), filename=path.name, original_upload=True)
    assert report["used_source"]
    finding = next(f for f in report["findings"] if f["rule_id"] == "L1.ARITH.LINE_AMOUNT")
    assert finding["target"]["line_id"] == result["positions"][0]["id"]
    assert finding["evidence"]["stated_amount"] == "85.00"
    assert finding["evidence"]["expected_amount"] == "50.00"
    assert all(finding["source_locator"][key] == value for key, value in locator.items())
    assert "50.00" in finding["suggested_fix"]["rationale"]


def test_pdf_missing_units_do_not_shift_printed_prices():
    from tender_import.pdf import read_quantity
    line = read_quantity("5,000  ...  10,00  50,00")
    assert line["unit"] is None
    assert line["unit_price"] == "10.00"
    assert line["line_amount"] == "50.00"


def test_legacy_xls_upload_keeps_sheet_amounts_and_has_independent_dependency_scopes(monkeypatch):
    from decimal import Decimal
    from analysis.contracts import AnalysisInput, Bom, Line, Project, Section, SourceAmounts, SourceDocument
    import workspace_analysis
    import workspace_parse

    def worksheet(name, short, quantity, rate, amount, printed_net):
        locator = {"sheet": name, "row": 3, "record": f"{name}!3"}
        return AnalysisInput(
            project=Project(source_document=SourceDocument(format="xls")),
            bom=Bom(title="Work", stated_net_total=Decimal(printed_net),
                    stated_net_total_locator={"sheet": name, "row": 5}),
            sections=[
                Section(id=f"{name}-section", code="01", title="Work", sort_order=1,
                        stated_total=Decimal(amount), stated_total_locator={"sheet": name, "row": 4}),
            ],
            lines=[
                Line(id=f"{name}-line", code="01.0010", section_id=f"{name}-section",
                     sort_order=1, short_text=short, quantity=Decimal(quantity), unit="m",
                     source_amounts=SourceAmounts(unit_price=Decimal(rate), line_amount=Decimal(amount)),
                     source_locator=locator),
            ],
        )

    electricity = worksheet("Elektro", "Randdämmstreifen liefern", "2", "10", "20", "20")
    floor = worksheet("Boden", "Zementestrich schwimmend, 65 mm", "5", "10", "50", "70")
    monkeypatch.setattr(workspace_parse, "read_document", lambda *_: ([electricity, floor], []))
    source = workspace_parse.original_document("sample.xls", b"fixture")
    result = workspace_parse.preview("sample.xls", b"fixture")
    assert [node["label"] for node in result["tree"]] == ["Elektro", "Boden"]
    assert [row["path"][-1]["oz"] for row in result["positions"]] == ["S1.01", "S2.01"]
    assert [line.section_id for line in source.lines] == ["S1.01", "S2.01"]
    assert source.bom.stated_net_total is None

    document = {**result, "fileName": "sample.xls", "source": {"kind": "xlsx"}}
    monkeypatch.setenv("ANALYSIS_L3_PROVIDER", "none")
    monkeypatch.setattr(workspace_analysis, "_source", lambda *_: source)
    report = workspace_analysis.run(_uploaded_input(document), object(), filename="sample.xls", original_upload=True)
    assert report["used_source"] and not report["errors"]
    by_rule = {f["rule_id"]: f for f in report["findings"]}
    assert "L1.CODE.DUPLICATE" not in by_rule
    assert "L1.ARITH.NET_TOTAL" not in by_rule
    total = by_rule["L1.ARITH.SECTION_TOTAL"]
    assert total["target"]["section_id"] == "S2"
    assert total["source_locator"] == {"sheet": "Boden", "row": 5}
    assert Decimal(total["evidence"]["difference"]) == Decimal("20")
    assert by_rule["L2.FLOOR.SCREED_NEEDS_EDGE_INSULATION"]["target"]["section_id"] == "S2"
