from pathlib import Path

import pytest

from analysis import adapter
from analysis.runner import analyze
import workspace_analysis


DATA = Path(__file__).resolve().parents[2] / "data"
HALL = DATA / "demo" / "building_hall_planted.X83"
AWARD = DATA / "tenders" / "StBALV23040.D86"
CHANGED_OZ = "01.02.0010"
AMOUNTS = {"L1.ARITH.LINE_AMOUNT", "L1.ARITH.SECTION_TOTAL", "L1.ARITH.NET_TOTAL"}


def upload_payload(file):
    source = adapter.from_file(file)
    sections = {None: []}
    tree_nodes = {None: []}
    for section in source.sections:
        part = {"oz": section.code, "label": section.title}
        sections[section.id] = [*sections[section.parent_id], part]
        node = {**part, "children": []}
        tree_nodes[section.parent_id].append(node)
        tree_nodes[section.id] = node["children"]
    positions = []
    for position, line in enumerate(source.lines):
        positions.append({
            "id": f"p{position}", "oz": line.code, "short": line.short_text, "long": line.long_text,
            "qty": line.quantity, "unit": line.unit_raw, "lumpSum": line.pricing_basis == "lump_sum",
            "up": line.source_amounts.unit_price if line.source_amounts else None,
            "path": sections[line.section_id],
        })
    document = {
        "title": source.bom.title, "fileName": file.name, "currency": "EUR", "phase": file.suffix[1:],
        "source": {"kind": "gaeb-xml" if file.suffix.startswith(".X") else "gaeb90"},
        "positions": positions, "tree": tree_nodes[None],
    }
    return source, workspace_analysis._uploaded_input(document)


@pytest.fixture(autouse=True)
def deterministic_assessment(monkeypatch):
    monkeypatch.setenv("ANALYSIS_L3_PROVIDER", "none")


def upload_report(monkeypatch, source, payload):
    monkeypatch.setattr(workspace_analysis, "_source", lambda *args: source)
    return workspace_analysis.run(payload, connection=object(), filename=source.project.source_document.filename)


def test_workspace_review_excludes_placeholder_findings_and_questions():
    payload = {"layers": [1], "snapshot": {"sections": [], "lines": [
        {"id": "first", "code": "01", "short_text": "Rohr", "long_text": "Fabrikat: [FIRMA_095], Dicke: ?",
         "quantity": 1, "unit": "m"},
    ]}}
    snapshot, layers = workspace_analysis.prepare(payload)
    placeholder = next(f for f in analyze(snapshot, layers).findings if f.rule_id == "L1.TEXT.SPEC_PLACEHOLDER")
    report = workspace_analysis.run(payload)
    assert "L1.TEXT.UNCLEAR_DIMENSION" in report["summary"]["by_rule"]
    assert "L1.TEXT.SPEC_PLACEHOLDER" not in report["summary"]["by_rule"]
    assert placeholder.id not in report["risk"]["points"]
    assert all(placeholder.id not in question["finding_ids"] for question in report["questions"])


def test_planted_x83_upload_checks_line_section_and_net_amounts(monkeypatch):
    source, payload = upload_payload(HALL)
    report = upload_report(monkeypatch, source, payload)
    assert report["used_source"]
    findings = {finding["rule_id"]: finding for finding in report["findings"] if finding["rule_id"] in AMOUNTS}
    assert set(findings) == AMOUNTS
    amount = findings["L1.ARITH.LINE_AMOUNT"]
    assert amount["target"]["line_code"] == CHANGED_OZ
    assert amount["evidence"]["expected_amount"] == "12420.00"
    assert all(section["code"] for section in report["risk"]["by_section"] if section["section_id"] is not None)
    assert "01.02" in {section["code"] for section in report["risk"]["by_section"]}


@pytest.mark.parametrize("edit", ["quantity", "rate", "unit", "add", "remove", "move"])
def test_only_unchanged_scopes_keep_stated_totals(edit):
    source, payload = upload_payload(HALL)
    lines = payload["snapshot"]["lines"]
    line = next(line for line in lines if line["code"] == CHANGED_OZ)
    if edit == "quantity":
        line["quantity"] += 1
    elif edit == "rate":
        line["price"]["unit_price"] += 1
    elif edit == "unit":
        line["unit"] = "kg"
    elif edit == "add":
        lines.append({**line, "id": "extra", "code": "01.02.9999"})
    elif edit == "remove":
        lines.remove(line)
    elif edit == "move":
        line["section_id"] = "03.01"
    snapshot, _ = workspace_analysis.prepare(payload)
    assert workspace_analysis._attach_source(snapshot, source, payload["original_codes"])
    totals = {section.id: section.stated_total for section in snapshot.sections}
    assert totals["01.02"] is None
    assert totals["01"] is None
    assert (totals["03.01"] is None) == (edit == "move")
    assert totals["04.01"] is not None
    assert snapshot.bom.stated_net_total is None
    if edit in {"quantity", "rate", "unit"}:
        assert snapshot.line_by_id()[line["id"]].source_amounts is None


@pytest.mark.parametrize("filename", [
    "Pruefdatei_GAEB_DA_XML_3.2_Bauausfuehrung_83.X83",
    "Pruefdatei_GAEB_DA_XML_3.3_Bauausfuehrung_2024-04-04.X83",
])
def test_workspace_duplicate_oz_includes_gaeb_index(filename):
    file = DATA / "fixtures" / "bvbs" / filename
    source_row = {"content": file.read_bytes(), "name": filename}
    source = workspace_analysis._parse_source(source_row)
    _, payload = upload_payload(file)
    payload["original_refs"] = {}
    source_pairs = list(zip(payload["snapshot"]["lines"], source.lines, strict=True))
    for line, original in source_pairs:
        # Previously imported lists store the item ID but omit the OZ index.
        if item_id := original.source_locator.get("indexed_item_id"):
            line["code"] = ".".join(original.code_parts[:-1])
            payload["original_codes"][line["id"]] = line["code"]
            payload["original_refs"][line["id"]] = item_id

    report = workspace_analysis.run(payload, source_row=source_row)
    assert report["used_source"]
    assert "L1.CODE.DUPLICATE" not in report["summary"]["by_rule"]

    # A real duplicate created by renumbering a row still needs review.
    renamed = next(line for line, original in source_pairs if original.code == "999.999.9999.z")
    renamed["code"] = "999.999.9999.y"
    report = workspace_analysis.run(payload, source_row=source_row)
    duplicates = [finding for finding in report["findings"] if finding["rule_id"] == "L1.CODE.DUPLICATE"]
    assert len(duplicates) == 1
    assert duplicates[0]["target"]["line_code"] == "999.999.9999.y"


def test_d86_upload_does_not_introduce_arithmetic_findings(monkeypatch):
    source, payload = upload_payload(AWARD)
    assert all("price" not in line for line in payload["snapshot"]["lines"])
    report = upload_report(monkeypatch, source, payload)
    def amounts(findings):
        return {(f["rule_id"], f["target"]["line_code"], f["evidence"].get("stated"), f["evidence"].get("difference"))
                for f in findings if f["rule_id"] in AMOUNTS}

    expected = amounts(analyze(source, [1, 2]).model_dump(mode="json")["findings"])
    actual = amounts(report["findings"])
    assert report["used_source"]
    assert actual <= expected


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
