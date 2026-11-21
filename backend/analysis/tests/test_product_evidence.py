from decimal import Decimal
import json
from pathlib import Path

import pytest

from analysis import adapter
from analysis.eval.gaeb_writer import to_bytes
from analysis.runner import analyze

EXAMPLES = Path(__file__).resolve().parents[3] / "data" / "examples"
MATERIAL = "L1.PRODUCT.DIN_MATERIAL"
STIFFNESS = "L1.PRODUCT.DRAINAGE_RING_STIFFNESS"
PROPERTY = "L1.PRODUCT.DECLARED_PROPERTY"
SCOPE = "L1.DIN.PIPE_MATERIAL_SCOPE"
EDITION = "L1.DIN.EDITION_UNCHECKED"


@pytest.fixture
def drainage():
    bom = json.loads((EXAMPLES / "drainage-variant-bom.json").read_text())
    package = json.loads((EXAMPLES / "drainage-variant-evidence.json").read_text())
    return {**package, "items": bom["positions"]}


def findings(data):
    items = [{"id": item["id"], "oz": item["oz"], "short_text": item["short"], "long_text": item["long"],
              "quantity": item["qty"], "unit": item["unit"]} for item in data["items"]]
    snapshot = adapter.from_data({**data, "items": items})
    return {finding.rule_id: finding for finding in analyze(snapshot, [1, 2]).findings}


def test_exact_offered_variant_conflicts_with_material_stiffness_and_diameter(drainage):
    report = findings(drainage)
    for rule_id in (MATERIAL, STIFFNESS, PROPERTY):
        finding = report[rule_id]
        assert finding.target.line_code == "01.10"
        assert finding.evidence["outcome"] == "conflict"
        assert finding.evidence["declarations"][0]["locator"] == "page 2, table 1"
        assert finding.suggested_fix is not None and finding.suggested_fix.operations == []
    assert report[MATERIAL].evidence["din_standard"]["identifier"] == "DIN EN 1401-1"
    assert report[MATERIAL].evidence["edition_basis"] == "public_scope"
    assert report[STIFFNESS].evidence["declared_sn"] == 4
    assert Decimal(report[PROPERTY].evidence["observed"]) == Decimal("125")


def test_matching_declaration_and_convertible_units_are_clean(drainage):
    declaration = drainage["declarations"][0]
    declaration["properties"]["material"]["value"] = "pvc-u"
    declaration["properties"]["outside_diameter"]["value"] = "16"
    declaration["ring_stiffness_sn"] = 8
    assert not {MATERIAL, STIFFNESS, PROPERTY, SCOPE, EDITION} & findings(drainage).keys()


@pytest.mark.parametrize("variant", ["P160-B", "P160-A+X", "p160-a"])
def test_wrong_or_partial_sku_does_not_supply_evidence(drainage, variant):
    item = drainage["items"][0]
    item["long"] = item["long"].replace("P160-A", variant)
    report = findings(drainage)
    for rule_id in (MATERIAL, STIFFNESS, PROPERTY):
        if rule_id in report:
            assert report[rule_id].evidence["outcome"] == "insufficient_evidence"
    assert report[PROPERTY].evidence["declarations"] == []


def test_incompatible_units_and_conflicting_declarations_require_evidence(drainage):
    declaration = drainage["declarations"][0]
    declaration["properties"]["outside_diameter"]["unit"] = "kg"
    drainage["declarations"].append({
        **declaration, "revision": "B", "ring_stiffness_sn": 8,
        "properties": {**declaration["properties"], "material": {"value": "PVC-U"}},
    })
    report = findings(drainage)
    assert all(report[rule].evidence["outcome"] == "insufficient_evidence" for rule in (MATERIAL, STIFFNESS, PROPERTY))


def test_unsupported_edition_in_detail_gates_undated_short_reference(drainage):
    row = drainage["items"][0]
    row["long"] = row["short"] + ":2019-09\n" + row["long"]
    report = findings(drainage)
    assert EDITION in report
    assert MATERIAL not in report
    assert STIFFNESS in report


@pytest.mark.parametrize(("number", "expected"), [("1401-1", "PVC-U"), ("1852-1", "PP"), ("12666-1", "PE")])
def test_explicit_specification_conflicts_even_without_an_offered_variant(drainage, number, expected):
    row = drainage["items"][0]
    specified = "PP" if expected == "PE" else "PE"
    row["short"] = f"{specified}-Abwasserrohr DN 160 gemäß DIN EN {number}"
    row["long"] = "Lieferung und Einbau."
    drainage["declarations"].clear()
    drainage["product_requirements"].clear()
    report = findings(drainage)
    assert report[SCOPE].evidence["specified_material"] == specified
    assert report[SCOPE].evidence["scope_material"] == expected
    assert not {MATERIAL, STIFFNESS, PROPERTY} & report.keys()



def test_x83_round_trip_preserves_offered_identity_and_din_reference(drainage):
    item = drainage["items"][0]
    content = to_bytes({
        "bom": {"title": "Synthetic drainage variant"},
        "sections": [{"id": "s", "code_parts": ["01"], "title": "Drainage"}],
        "lines": [{"id": item["id"], "section_id": "s", "code_parts": ["01", "0010"],
                   "quantity": item["qty"], "unit": item["unit"],
                   "short_text": item["short"], "long_text": item["long"]}],
    })
    parsed = adapter.from_bytes("drainage.X83", content)
    snapshot = adapter.from_data({
        **parsed.model_dump(mode="json"), "declarations": drainage["declarations"],
        "product_requirements": drainage["product_requirements"],
    })
    conflicts = {f.rule_id: f for f in analyze(snapshot, [1, 2]).findings
                 if f.evidence.get("outcome") == "conflict"}
    assert {MATERIAL, STIFFNESS, PROPERTY} <= conflicts.keys()
    assert all(conflicts[rule].target.line_id == parsed.lines[0].id for rule in (MATERIAL, STIFFNESS, PROPERTY))
