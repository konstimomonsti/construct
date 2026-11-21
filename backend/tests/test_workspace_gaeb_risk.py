"""Replay original GAEB evidence through the assessment worker's upload path."""

from decimal import Decimal

import pytest

from analysis import adapter
from analysis.eval.gaeb_writer import to_bytes
from analysis.runner import analyze
from exports import legacy_export
import workspace_analysis


def x83_content():
    return to_bytes({
        "project": {"currency": "EUR"},
        "bom": {"title": "Synthetic tender", "stated_net_total": Decimal("35")},
        "sections": [{"id": "section", "code_parts": ["01"], "title": "Work", "stated_total": Decimal("32")}],
        "lines": [
            {"id": "I1", "section_id": "section", "code_parts": ["01", "0010"], "quantity": Decimal("2"),
             "unit": "m", "short_text": "Montage einer Schutzleitung",
             "source_amounts": {"unit_price": Decimal("10"), "line_amount": Decimal("25")}},
            {"id": "I2", "section_id": "section", "code_parts": ["01", "0020"],
             "unit": "m", "short_text": "Montage einer Signalleitung"},
        ],
    })


def d86_content():
    content = legacy_export({
        "version": {"title": "Synthetic tender", "project_name": "Synthetic project", "currency": "EUR"},
        "sections": [{"display_code": "01", "title": "Work"}],
        "lines": [
            {"line_code": "01.0010", "quantity": Decimal("2"), "unit_code": "m",
             "short_description": "Montage einer Schutzleitung", "draft_unit_price": Decimal("10"),
             "pricing_basis": "unit_rate", "total_rule": "include", "alternative_for_line_id": None},
        ],
    }, "86")
    from tender_import.legacy import _FIELDS
    start, end = _FIELDS["23"]["line_amount"]
    records = [row[:start] + b"000000002500" + row[end:] if row.startswith(b"23") else row
               for row in content.splitlines()]
    return b"\r\n".join(records) + b"\r\n"


def uploaded_input(source, filename, phase):
    section = {"oz": "01", "label": "Work"}
    return workspace_analysis._uploaded_input({
        "fileName": filename,
        "phase": phase,
        "source": {"kind": "gaeb-xml" if phase == "83" else "gaeb90"},
        "positions": [
            {"id": f"p{index}", "oz": line.code, "short": line.short_text, "qty": float(line.quantity or 0),
             "up": float(line.source_amounts.unit_price) if line.source_amounts else None,
             "unit": line.unit_raw, "path": [section],
             "srcRef": (line.source_locator.get("source_id") or line.source_locator.get("sequence"))}
            for index, line in enumerate(source.lines, 1)
        ],
    })


@pytest.mark.parametrize(("filename", "content", "expected"), [
    ("synthetic.X83", x83_content, {
        "L1.ARITH.LINE_AMOUNT": "p1", "L1.ARITH.SECTION_TOTAL": "01",
        "L1.ARITH.NET_TOTAL": None, "L1.QTY.MISSING": "p2",
    }),
    ("synthetic.D86", d86_content, {"L1.ARITH.LINE_AMOUNT": "p1", "L1.ARITH.NET_TOTAL": None}),
])
def test_upload_keeps_original_file_arithmetic_and_position_ids(monkeypatch, filename, content, expected):
    source = adapter.from_bytes(filename, content())
    payload = uploaded_input(source, filename, source.project.gaeb_phase)
    monkeypatch.setenv("ANALYSIS_L3_PROVIDER", "none")
    monkeypatch.setattr(workspace_analysis, "_source", lambda *_: source)
    report = workspace_analysis.run(payload, object(), filename=filename, original_upload=True)
    findings = {f["rule_id"]: f for f in report["findings"]}
    assert report["used_source"]
    for rule_id, target_id in expected.items():
        finding = findings[rule_id]
        assert (finding["target"]["line_id"] or finding["target"]["section_id"]) == target_id
        assert finding["suggested_fix"]["rationale"]
    amount = findings["L1.ARITH.LINE_AMOUNT"]
    assert amount["source_locator"].get("source_id" if filename.endswith("X83") else "record")
    assert Decimal(amount["evidence"]["stated_amount"]) == Decimal("25")
    assert Decimal(amount["evidence"]["expected_amount"]) == Decimal("20")


def test_original_upload_uses_references_to_map_duplicate_position_codes():
    source = adapter.from_bytes("synthetic.X83", x83_content())
    source.lines[1].code = source.lines[0].code
    payload = uploaded_input(source, "synthetic.X83", "83")
    parsed, _ = workspace_analysis.prepare({**payload, "layers": [1]})
    snapshot = workspace_analysis._original_tender(parsed, source, payload["original_refs"])
    assert [line.id for line in snapshot.lines] == ["p1", "p2"]
    assert [line.source_locator["source_id"] for line in snapshot.lines] == ["I1", "I2"]
    assert any(f.rule_id == "L1.CODE.DUPLICATE" for f in analyze(snapshot, [1]).findings)


def test_review_of_a_draft_keeps_the_edited_quantity_and_skips_stale_original_amount(monkeypatch):
    source = adapter.from_bytes("synthetic.X83", x83_content())
    payload = uploaded_input(source, "synthetic.X83", "83")
    payload["snapshot"]["lines"][0]["quantity"] = 4
    monkeypatch.setenv("ANALYSIS_L3_PROVIDER", "none")
    monkeypatch.setattr(workspace_analysis, "_source", lambda *_: source)
    report = workspace_analysis.run(payload, object(), filename="synthetic.X83")
    assert report["used_source"]
    assert not any(f["rule_id"].startswith("L1.ARITH.") for f in report["findings"])
