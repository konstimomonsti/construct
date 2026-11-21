"""Tests for workspace analysis upload path, source evidence attachment and arithmetic reconciliation."""

from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from analysis import adapter, runner
from analysis.contracts import Bom, Line, PriceInfo, Project, Section, SourceAmounts, SourceDocument
import workspace_analysis

ROOT = Path(__file__).resolve().parent.parent.parent
DEMO_X83 = ROOT / "data" / "demo" / "building_hall_planted.X83"
STBA_D86 = ROOT / "data" / "tenders" / "StBALV23040.D86"


def _make_document(source, edits=None):
    sec_by_id = {s.id: s for s in source.sections}

    def full_path(sec_id):
        chain = []
        curr = sec_by_id.get(sec_id)
        while curr:
            chain.append({"oz": curr.code, "label": curr.title})
            curr = sec_by_id.get(curr.parent_id)
        return list(reversed(chain))

    positions = []
    edits = edits or {}
    for line in source.lines:
        line_edit = edits.get(line.code, {})
        qty = line_edit.get("qty", float(line.quantity) if line.quantity is not None else None)
        up = line_edit.get(
            "up",
            float(line.source_amounts.unit_price) if line.source_amounts and line.source_amounts.unit_price else None,
        )
        positions.append({
            "id": line.id,
            "oz": line.code,
            "qty": qty,
            "unit": line.unit,
            "up": up,
            "short": line.short_text,
            "long": line.long_text,
            "path": full_path(line.section_id),
        })

    return {
        "fileName": source.project.source_document.filename or "tender.x83",
        "phase": source.project.gaeb_phase or "83",
        "currency": source.project.currency or "EUR",
        "source": {"kind": "gaeb-xml"},
        "title": source.bom.title,
        "positions": positions,
        "tree": [{"oz": s.code, "label": s.title, "children": []} for s in source.sections if not s.parent_id],
    }


def test_uploaded_list_building_hall_planted_arithmetic():
    """Acceptance criterion 1 & 5: upload path matches CLI arithmetic findings and carries OZ code."""
    source = adapter.from_file(DEMO_X83)
    doc = _make_document(source)
    inp = workspace_analysis._uploaded_input(doc)
    snapshot, layers = workspace_analysis.prepare(inp)

    # Verify section codes are present
    assert all(s.code is not None for s in snapshot.sections)

    workspace_analysis._attach_source(snapshot, source, inp["original_codes"])
    result = runner.analyze(snapshot, [1])

    arith_by_rule = {f.rule_id: f for f in result.findings if "ARITH" in f.rule_id}
    assert "L1.ARITH.LINE_AMOUNT" in arith_by_rule
    assert "L1.ARITH.SECTION_TOTAL" in arith_by_rule
    assert "L1.ARITH.NET_TOTAL" in arith_by_rule

    line_finding = [f for f in result.findings if f.rule_id == "L1.ARITH.LINE_AMOUNT"][0]
    assert line_finding.target.line_code == "01.02.0010"

    # Section findings exist for 01.02 and 01
    sec_findings = [f for f in result.findings if f.rule_id == "L1.ARITH.SECTION_TOTAL"]
    sec_targets = {f.target.section_id for f in sec_findings}
    assert "01.02" in sec_targets
    assert "01" in sec_targets


def test_uploaded_list_user_edit_clears_source_amount_findings():
    """Acceptance criterion 2: editing 01.02.0010 removes false source-amount findings."""
    source = adapter.from_file(DEMO_X83)
    # User edits 01.02.0010 quantity to 950.0
    doc = _make_document(source, edits={"01.02.0010": {"qty": 950.0}})
    inp = workspace_analysis._uploaded_input(doc)
    snapshot, layers = workspace_analysis.prepare(inp)

    workspace_analysis._attach_source(snapshot, source, inp["original_codes"])
    result = runner.analyze(snapshot, [1])

    # No arithmetic findings on edited line or its sections
    arith_findings = [f for f in result.findings if "ARITH" in f.rule_id]
    assert not arith_findings


def test_clean_priced_gaeb_file_has_no_spurious_upload_findings():
    """Acceptance criterion 3: clean priced GAEB file yields consistent arithmetic findings."""
    if not STBA_D86.exists():
        pytest.skip(f"{STBA_D86} not found")
    source = adapter.from_file(STBA_D86)
    doc = _make_document(source)
    inp = workspace_analysis._uploaded_input(doc)
    snapshot, layers = workspace_analysis.prepare(inp)

    workspace_analysis._attach_source(snapshot, source, inp["original_codes"])
    upload_result = runner.analyze(snapshot, [1])
    cli_result = runner.analyze(source, [1])

    upload_arith = {f.rule_id for f in upload_result.findings if "ARITH" in f.rule_id}
    cli_arith = {f.rule_id for f in cli_result.findings if "ARITH" in f.rule_id}
    assert upload_arith == cli_arith


def test_signed_credits_and_invalid_negative_rates():
    """Negative unit price without credit indicator triggers L1.PRICE.NEGATIVE; credits are allowed."""
    normal_negative = Line(
        id="l1",
        code="01.01.0010",
        sort_order=0,
        quantity=Decimal(10),
        unit="m²",
        short_text="Standard Mauerwerk",
        source_amounts=SourceAmounts(unit_price=Decimal("-50.00"), line_amount=Decimal("-500.00")),
    )
    credit_line = Line(
        id="l2",
        code="01.01.0020",
        sort_order=1,
        quantity=Decimal(1),
        unit="psch",
        short_text="Nachlass auf Gesamtangebot",
        source_amounts=SourceAmounts(unit_price=Decimal("-100.00"), line_amount=Decimal("-100.00")),
    )
    sec = Section(id="s1", code="01.01", sort_order=0)
    inp = adapter.finalize(
        adapter.AnalysisInput(
            project=Project(gaeb_phase="84"),
            bom=Bom(),
            sections=[sec],
            lines=[normal_negative, credit_line],
        )
    )
    result = runner.analyze(inp, [1])
    negative_findings = [f for f in result.findings if f.rule_id == "L1.PRICE.NEGATIVE"]
    assert len(negative_findings) == 1
    assert negative_findings[0].target.line_id == "l1"


def test_nan_infinity_oversized_numbers():
    """NaN, infinity and oversized numbers (> 10^12) are rejected with import warnings."""
    payload = {
        "lines": [
            {"id": "l1", "quantity": "NaN", "short_text": "Bad qty"},
            {"id": "l2", "quantity": 10, "short_text": "Huge amount", "price": {"unit_price": "10000000000000"}},
            {"id": "l3", "quantity": "Infinity", "short_text": "Inf qty"},
        ],
        "sections": [],
    }
    snap = adapter.from_data(payload)
    warnings = {w.code for w in snap.import_warnings}
    assert "INVALID_NUMBER" in warnings
    assert "OVERSIZED_NUMBER" in warnings
    assert snap.lines[0].quantity is None
    assert snap.lines[1].price.unit_price is None
    assert snap.lines[2].quantity is None
