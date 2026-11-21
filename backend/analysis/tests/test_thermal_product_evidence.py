from decimal import Decimal
from pathlib import Path

import pytest

from analysis.adapter import from_bytes, from_data
from analysis.contracts import ProductDeclaration, ProductRequirement
from analysis.runner import analyze

PROPERTY = "L1.PRODUCT.DECLARED_PROPERTY"
CONFLICT = "L1.PRODUCT.REQUIREMENT_CONFLICT"
DESIGN = "thermal_conductivity_design"
DECLARED = "thermal_conductivity_declared"
UNIT = "W/(mK)"
HEADING = "Dämmplatten EPS, 80 mm"
LIMIT = "Bemessungswert: höchstens 0,035 W/(mK)."
OFFER = "Angebotenes Fabrikat: Hersteller: Synthetic Insulation; SKU: EPS-80"


def evidence(value, unit=UNIT, *, prop=DESIGN, sku="EPS-80", revision="A"):
    return {"manufacturer": "Synthetic Insulation", "product_code": sku, "document": "Synthetic declaration",
            "revision": revision, "locator": "p. 2, thermal table", "properties": {prop: {"value": value, "unit": unit}}}


def schedule(value, unit=UNIT, *, prop=DESIGN, comparison="equal", code="01.0010", page=2):
    return {"position_code": code, "position_locator": {"page": page}, "property_name": prop,
            "comparison": comparison, "required": {"value": value, "unit": unit},
            "document": "Insulation schedule", "locator": "Row 8, conductivity"}


def findings(*items, heading=HEADING, detail=LIMIT, offer=OFFER, requirements=()):
    snapshot = from_data({"lines": [{"id": "thermal", "code": "01.0010", "short_text": heading,
                                    "long_text": "\n".join(part for part in (detail, offer) if part),
                                    "quantity": 25, "unit": "m²", "source_locator": {"page": 2}}],
                          "declarations": list(items), "product_requirements": list(requirements)})
    result = analyze(snapshot, [1, 2])
    assert not result.errors
    return [f for f in result.findings if f.rule_id in {PROPERTY, CONFLICT}]


@pytest.mark.parametrize("value,unit", [("40", "mW/(m·K)"), ("0,04", UNIT), ("35.000000000000000000000000001", "mW/(mK)")])
def test_exact_variant_above_written_limit_cites_normalized_units_and_sources(value, unit):
    finding, = findings(evidence(value, unit), evidence("0.032", sku="EPS-90"))
    assert finding.severity == "warning"
    assert finding.evidence["outcome"] == "conflict"
    assert finding.evidence["requirement"]["quote"] == LIMIT.rstrip(".")
    assert finding.evidence["observed_unit"] == "W/(m·K)"
    assert Decimal(finding.evidence["observed"]) > Decimal("0.035")
    assert finding.evidence["declarations"][0]["locator"] == "p. 2, thermal table"
    assert len(finding.evidence["declarations"]) == 1
    assert finding.source_locator == {"page": 2}
    assert finding.suggested_fix and not finding.suggested_fix.operations


@pytest.mark.parametrize("value,unit", [("35", "mW/(m·K)"), ("0,030", UNIT)])
def test_equal_and_lower_values_clear_the_maximum(value, unit):
    assert findings(evidence(value, unit)) == []


@pytest.mark.parametrize("declarations,reason", [
    ([evidence("0.03", prop=DECLARED)], "thermal_basis_unverified"),
    ([evidence("35", "m²K/W")], "thermal_evidence_unverified"),
    ([evidence("0.04", "MW/(mK)")], "thermal_evidence_unverified"),
    ([evidence("0.04", None)], "thermal_evidence_unverified"),
    ([evidence("0.00")], "thermal_evidence_unverified"),
    ([evidence("35", "mW/mK"), evidence("0.040", revision="B")], "thermal_evidence_unverified"),
    ([evidence("0.04", sku="EPS-81")], "thermal_evidence_unverified"),
])
def test_missing_or_incomparable_evidence_gets_a_review(declarations, reason):
    finding, = findings(*declarations)
    assert finding.severity == "info"
    assert finding.evidence["outcome"] == "insufficient_evidence"
    assert finding.evidence["reason"] == reason


def test_same_units_and_basis_for_declared_value_are_independently_supported():
    finding, = findings(evidence("0.04", prop=DECLARED),
                        detail="Nennwert höchstens 35 mW/(mK).")
    assert finding.evidence["requirement"]["property_name"] == DECLARED
    assert finding.evidence["outcome"] == "conflict"


@pytest.mark.parametrize("heading,detail,offer", [
    ("Dämmplatten EPS WLG 035", "", OFFER),
    (HEADING, "Wärmeleitfähigkeit höchstens 0,035 W/(mK).", OFFER),
    (HEADING, "Einschließlich Randdämmstreifen mit Bemessungswert höchstens 0,035 W/(mK).", OFFER),
    (HEADING, LIMIT, "Fabrikat der Planung: Hersteller: Synthetic Insulation; SKU: EPS-80"),
])
def test_no_unwritten_basis_or_reference_product_is_inferred(heading, detail, offer):
    assert findings(evidence("0.04"), heading=heading, detail=detail, offer=offer) == []


def test_incompatible_written_and_attached_values_hold_product_judgment():
    finding, = findings(evidence("0.04"), requirements=[schedule("40", "mW/(mK)")])
    assert finding.rule_id == CONFLICT
    assert {c["document"] for c in finding.evidence["requirements"]} == {"Original tender", "Insulation schedule"}
    assert any(c.get("quote") == LIMIT.rstrip(".") for c in finding.evidence["requirements"])


def test_equivalent_written_and_attached_limits_make_only_one_review():
    finding, = findings(evidence("0.04"), requirements=[schedule("35", "mW/(mK)", comparison="at_most")])
    assert finding.rule_id == PROPERTY
    assert finding.evidence["requirement"]["document"] == "Insulation schedule"


def test_conflicting_written_values_hold_product_comparison_even_with_schedule():
    assert findings(evidence("0.04"), heading=HEADING + ", Bemessungswert: 0,040 W/(mK)",
                    requirements=[schedule("35", "mW/(mK)", comparison="at_most")]) == []


def test_synthetic_project_evidence_can_reference_original_screed_position():
    path = Path(__file__).resolve().parents[3] / "data/tenders/LV_18_Estrich.pdf"
    original = from_bytes(path.name, path.read_bytes())
    row = next(line for line in original.lines if line.code == "11.3.20.")
    offer = row.model_copy(update={"long_text": row.long_text + "\n" + OFFER})
    project = original.model_copy(update={
        "lines": [offer], "declarations": [ProductDeclaration.model_validate(evidence("0.04"))],
    })
    assert not any(f.rule_id == PROPERTY for f in analyze(project, [1]).findings)
    requirement = ProductRequirement.model_validate(schedule("35", "mW/(mK)", comparison="at_most", code=row.code))
    with_schedule = project.model_copy(update={"product_requirements": [requirement]})
    finding, = [f for f in analyze(with_schedule, [1]).findings if f.rule_id == PROPERTY]
    assert finding.evidence["outcome"] == "conflict"
    assert finding.source_locator == row.source_locator
