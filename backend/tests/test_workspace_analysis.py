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
