from copy import deepcopy
from decimal import Decimal
from hashlib import sha256
import json
from pathlib import Path

import pytest

from analysis import adapter
from analysis.contracts import ProductRequirement
from analysis.eval.gaeb_writer import to_bytes
from analysis.runner import analyze

EXAMPLES = Path(__file__).resolve().parents[3] / "data" / "examples"
MATERIAL = "L1.PRODUCT.DIN_MATERIAL"
STIFFNESS = "L1.PRODUCT.DRAINAGE_RING_STIFFNESS"
PROPERTY = "L1.PRODUCT.DECLARED_PROPERTY"
REQUIREMENT_CONFLICT = "L1.PRODUCT.REQUIREMENT_CONFLICT"
SCOPE = "L1.DIN.PIPE_MATERIAL_SCOPE"
EDITION = "L1.DIN.EDITION_UNCHECKED"


@pytest.fixture
def drainage():
    bom = json.loads((EXAMPLES / "drainage-variant-bom.json").read_text())
    package = json.loads((EXAMPLES / "drainage-variant-evidence.json").read_text())
    return {**package, "items": bom["positions"]}


def snapshot_from_drainage(data):
    items = [{"id": item["id"], "oz": item["oz"], "short_text": item["short"], "long_text": item["long"],
              "quantity": item["qty"], "unit": item["unit"], "source_locator": item.get("source_locator", {})}
             for item in data["items"]]
    return adapter.from_data({**data, "items": items})


def findings(data):
    return {finding.rule_id: finding for finding in analyze(snapshot_from_drainage(data), [1, 2]).findings}


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


@pytest.mark.parametrize("offer", [
    "Angebotenes Fabrikat: Hersteller: Synthetic Works; SKU: P160-A",
    "Angebotenes Fabrikat:\r\nHersteller: Synthetic Works\r\nArt.-Nr.: P160-A",
    "Offered product: Manufacturer: Synthetic Works; SKU: P160-A",
])
def test_explicit_offer_is_checked_with_separate_design_reference(drainage, offer):
    row = drainage["items"][0]
    row["long"] = ("Mindestens SN 8.\nFabrikat der Planung:\nHersteller: Reference Works; SKU: R160\n"
                   "oder gleichwertig.\n" + offer)
    report = findings(drainage)
    for rule in (MATERIAL, STIFFNESS, PROPERTY):
        item = report[rule]
        assert item.evidence["outcome"] == "conflict"
        assert item.evidence["offer_quote"] == offer.replace("\r\n", "\n")
        assert item.evidence["offer_field"] == "long_text"
        assert item.evidence["declarations"][0]["product_code"] == "P160-A"
        assert item.suggested_fix and not item.suggested_fix.operations


@pytest.mark.parametrize("heading,detail", [
    ("", "Fabrikat der Planung:\nHersteller: Synthetic Works; SKU: P160-A"),
    ("", "Hersteller: Synthetic Works; SKU: P160-A\noder gleichwertig"),
    ("", "Hersteller: Synthetic Works; SKU: ........"),
    ("", "Hersteller: ______; SKU: P160-A"),
    ("", "Hersteller: Synthetic Works; SKU: P160-A\nAngebotenes Fabrikat: [Bieterangabe]"),
    ("\nHersteller: Synthetic Works", "SKU: P160-A"),
    ("", "Angebotenes Fabrikat: Hersteller: Synthetic Works; SKU: P160-A\n"
         "Angebotenes Fabrikat: Hersteller: Synthetic Works; SKU: P160-B"),
    ("", "Angebotenes Fabrikat: Hersteller: Synthetic Works; SKU: P160-A\nWahlweise auch SN 4."),
    ("", "Angebotenes Fabrikat: Hersteller: Synthetic Works; SKU: P160-A; oder gleichwertig."),
    ("", "Angebotenes Fabrikat: Hersteller: Synthetic Works; SKU: P160-A\nAngebotenes Fabrikat: [Bieterangabe]"),
])
def test_never_turns_reference_placeholders_or_competing_offers_into_a_product_conflict(drainage, heading, detail):
    row = drainage["items"][0]
    row["short"] += heading
    row["long"] = "Mindestens SN 8.\n" + detail
    report = findings(drainage)
    assert report[PROPERTY].evidence["outcome"] == "insufficient_evidence"
    for rule in (MATERIAL, STIFFNESS, PROPERTY):
        if rule in report:
            assert report[rule].severity == "info"
            assert report[rule].evidence["declarations"] == []


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



@pytest.mark.parametrize(("source", "selector"), [
    ({"sheet": "Roof", "row": 4}, {"sheet": "Roof", "row": 4}),
    ({"page": 3}, {"page": 3}),
    ({"table": 2, "row": 7}, {"table": 2, "row": 7}),
    ({"source_id": "source-item-b"}, {"source_id": "source-item-b"}),
    ({"record": 15}, {"record": 15}),
    ({"paragraph": 9}, {"paragraph": 9}),
])
def test_requirement_targets_exact_source_with_repeated_codes(drainage, source, selector):
    first = drainage["items"][0]
    first["source_locator"] = {"sheet": "Elsewhere", "row": 4}
    first["long"] = "Hersteller: Other Works; SKU: C160"
    qualified = {**first, "id": "target", "oz": "01.0010", "source_locator": source,
                 "long": "Hersteller: Synthetic Works; SKU: P160-A"}
    drainage["items"].append(qualified)
    drainage["product_requirements"][0]["position_locator"] = selector
    finding = findings(drainage)[PROPERTY]
    assert finding.target.line_id == "target"
    assert finding.source_locator == source
    assert finding.evidence["requirement"]["position_locator"] == selector
    assert finding.evidence["outcome"] == "conflict"
    assert finding.suggested_fix and not finding.suggested_fix.operations


def test_unqualified_repeated_code_reports_candidate_positions(drainage):
    first = drainage["items"][0]
    first["source_locator"] = {"sheet": "First", "row": 3}
    drainage["items"].append({**first, "id": "second", "source_locator": {"sheet": "Second", "row": 3}})
    finding = findings(drainage)[PROPERTY]
    assert finding.severity == "info" and finding.target.line_id is None
    assert finding.related_line_ids == [first["id"], "second"]
    assert finding.evidence["reason"] == "position_ambiguous"
    assert finding.evidence["position_candidate_count"] == 2
    assert [row["locator"]["sheet"] for row in finding.evidence["position_candidates"]] == ["First", "Second"]
    assert not finding.evidence["declarations"]
    assert "worksheet and row" in finding.suggested_fix.rationale


def test_wrong_source_coordinates_do_not_fall_back_to_a_unique_code(drainage):
    item = drainage["items"][0]
    item["source_locator"] = {"sheet": "First", "row": 3}
    drainage["items"].append({**item, "id": "other", "oz": "01.0020",
                              "source_locator": {"sheet": "First", "row": 9}})
    drainage["product_requirements"][0]["position_locator"] = {"sheet": "First", "row": 9}
    finding = findings(drainage)[PROPERTY]
    assert finding.severity == "info" and finding.target.line_id is None
    assert finding.related_line_ids == [item["id"]]
    assert finding.evidence["reason"] == "position_locator_mismatch"


def test_partial_coordinates_must_still_identify_one_position(drainage):
    item = drainage["items"][0]
    item["source_locator"] = {"sheet": "First", "row": 3}
    drainage["items"].append({**item, "id": "second", "source_locator": {"sheet": "Second", "row": 3}})
    drainage["product_requirements"][0]["position_locator"] = {"row": 3}
    assert findings(drainage)[PROPERTY].evidence["reason"] == "position_ambiguous"


@pytest.mark.parametrize("locator", [{}, {"row": 0}, {"page": "2"}, {"row": True}, {"unknown": "A"}, {"sheet": " "}])
def test_invalid_position_coordinates_reject_the_attachment_requirement(drainage, locator):
    with pytest.raises(ValueError):
        ProductRequirement.model_validate({**drainage["product_requirements"][0], "position_locator": locator})


def test_existing_unqualified_requirements_keep_their_snapshot_hash(drainage):
    snapshot = snapshot_from_drainage(drainage)
    payload = snapshot.model_dump(mode="json", exclude={"input_hash"})
    assert "position_locator" not in payload["product_requirements"][0]
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    assert snapshot.input_hash == sha256(canonical.encode("utf-8")).hexdigest()

    qualified = deepcopy(payload)
    qualified["product_requirements"][0]["position_locator"] = {"sheet": "First", "row": 3}
    assert adapter.from_data(qualified).input_hash != snapshot.input_hash


def bind_requirements(drainage, entries, *, name="outside_diameter"):
    template = drainage["product_requirements"][0]
    drainage["product_requirements"] = [
        {**template, "comparison": operator, "property_name": name, "required": {
            "value": value, **({"unit": unit} if unit else {}),
        }, "document": f"Document {index}", "locator": f"Detail {index}",
         "attachment_id": f"attachment-{index}", "attachment_sha256": str(index) * 64}
        for index, (operator, value, unit) in enumerate(entries, 1)
    ]


@pytest.mark.parametrize("requirements", [
    [("at_least", "160", "mm"), ("at_most", "15", "cm")],
    [("equal", "160", "mm"), ("equal", "15", "cm")],
    [("equal", "15", "cm"), ("at_least", "0.16", "m")],
    [("at_most", "10", None), ("at_least", "12", None)],
    [("equal", "C-s1,d0", None), ("equal", "B-s1,d0", None)],
    [("at_least", "300", "kPa"), ("at_most", "250", "kPa")],
])
def test_incompatible_requirements_cite_both_sources_before_comparing_the_offer(drainage, requirements):
    bind_requirements(drainage, requirements)
    report = findings(drainage)
    conflict = report[REQUIREMENT_CONFLICT]
    assert PROPERTY not in report
    assert conflict.target.line_code == "01.10"
    assert conflict.evidence["outcome"] == "requirement_conflict"
    evidence = sorted(conflict.evidence["requirements"], key=lambda r: r["document"])
    assert [(r["document"], r["locator"], r["attachment_id"]) for r in evidence] == [
        ("Document 1", "Detail 1", "attachment-1"), ("Document 2", "Detail 2", "attachment-2"),
    ]
    assert conflict.suggested_fix and not conflict.suggested_fix.operations
    assert "specification owner" in conflict.suggested_fix.rationale


@pytest.mark.parametrize("requirements", [
    [("at_least", "125", "mm"), ("at_most", "12,5", "cm")],
    [("equal", "125", "mm"), ("equal", "12.50", "cm")],
    [("at_least", "0.12", "m"), ("at_most", "13", "cm")],
    [("at_least", "125", "mm"), ("at_least", "12", "cm")],
])
def test_compatible_requirements_preserve_product_checks(drainage, requirements):
    bind_requirements(drainage, requirements)
    report = findings(drainage)
    assert REQUIREMENT_CONFLICT not in report
    assert PROPERTY not in report
    drainage["declarations"][0]["properties"]["outside_diameter"]["value"] = "11"
    report = findings(drainage)
    assert REQUIREMENT_CONFLICT not in report
    assert report[PROPERTY].evidence["outcome"] == "conflict"


@pytest.mark.parametrize("first,second", [
    ("mm", "kg"), ("month", "day"), ("ea", "set"), ("kPa", "MPa"), ("mm", None),
])
def test_units_without_a_safe_conversion_do_not_prove_a_source_conflict(drainage, first, second):
    bind_requirements(drainage, [("at_least", "300", first), ("at_most", "250", second)])
    assert REQUIREMENT_CONFLICT not in findings(drainage)


def test_conflict_detection_uses_only_requirements_attached_to_the_same_resolved_position(drainage):
    first = drainage["items"][0]
    first["source_locator"] = {"sheet": "Primary", "row": 3}
    drainage["items"].append({**first, "id": "second", "source_locator": {"sheet": "Reserve", "row": 3}})
    bind_requirements(drainage, [("at_least", "160", "mm"), ("at_most", "150", "mm")])
    drainage["product_requirements"][0]["position_locator"] = {"sheet": "Primary"}
    drainage["product_requirements"][1]["position_locator"] = {"sheet": "Reserve"}
    report = findings(drainage)
    assert REQUIREMENT_CONFLICT not in report
    assert report[PROPERTY].target.line_id == first["id"]


def test_identical_declared_and_required_units_can_be_compared_for_unlisted_property_units(drainage):
    bind_requirements(drainage, [("at_least", "450", "kPa")], name="pressure")
    drainage["declarations"][0]["properties"]["pressure"] = {"value": "425", "unit": "kPa"}
    assert findings(drainage)[PROPERTY].evidence["outcome"] == "conflict"


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
