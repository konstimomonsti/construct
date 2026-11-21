from decimal import Decimal
from pathlib import Path
import re

import pytest

from analysis.adapter import from_bytes, from_data
from analysis.contracts import ProductDeclaration
from analysis.layer1.fire_installation import MIN_THICKNESS, SUPPORT
from analysis.runner import analyze

PROPERTY = "L1.PRODUCT.DECLARED_PROPERTY"
REQUIREMENT_CONFLICT = "L1.PRODUCT.REQUIREMENT_CONFLICT"
OFFER = "Angebotenes Fabrikat: Hersteller: Synthetic Doors; SKU: D-24"


def declaration(value, sku="D-24", *, revision="A"):
    return {"manufacturer": "Synthetic Doors", "product_code": sku, "document": "Synthetic Declaration",
            "revision": revision, "locator": "p. 2, classification table",
            "properties": {"fire_resistance_class": {"value": value}}}


def installation_declaration(rating, support, minimum=None, unit="mm", *, revision="A"):
    result = declaration(rating, revision=revision)
    if support is not None:
        result["properties"][SUPPORT] = {"value": support}
    if minimum is not None:
        result["properties"][MIN_THICKNESS] = {"value": minimum, "unit": unit}
    return result


def schedule(value, comparison="equal"):
    return {"position_code": "01.0010", "position_locator": {"page": 3},
            "property_name": "fire_resistance_class", "comparison": comparison, "required": {"value": value},
            "document": "Door Schedule", "locator": "D-24, fire class"}


def findings(heading, detail, declarations, requirements=(), offer=OFFER):
    snapshot = from_data({
        "lines": [{"id": "door", "code": "01.0010", "short_text": heading,
                   "long_text": "\n".join(part for part in (detail, offer) if part),
                   "quantity": "1", "unit": "St", "source_locator": {"page": 3}}],
        "declarations": declarations, "product_requirements": list(requirements),
    })
    result = analyze(snapshot, [1, 2])
    assert not result.errors
    return [finding for finding in result.findings if finding.rule_id in {PROPERTY, REQUIREMENT_CONFLICT}]


@pytest.mark.parametrize("heading,detail,expected,observed,quote", [
    ("Brandschutztür, 1000 x 2125 mm", "Feuerwiderstand: EI₂ 60-C5 Sₐ.", "EI2 60 C5 SA", "EI2 30 Sa C5", "EI₂ 60-C5 Sₐ"),
    ("T 60 RS - Stahltürelement", "", "T 60 RS", "T30-RS", "T 60 RS"),
    ("Brandschutztür mindestens EI2 60-S200 C5", "", "EI2 60 C5 S200", "EI₂ 30-C5 S₂₀₀", "mindestens EI2 60-S200 C5"),
])
def test_lower_declared_door_class_cites_the_requirement_and_exact_offer(heading, detail, expected, observed, quote):
    finding, = findings(heading, detail, [declaration(observed), declaration(expected, "D-25")])
    assert finding.severity == "warning"
    assert finding.evidence["outcome"] == "conflict"
    assert finding.evidence["requirement"]["required"]["value"] == expected
    assert finding.evidence["requirement"]["quote"] == quote
    assert finding.evidence["offer_quote"] == OFFER
    assert [item["product_code"] for item in finding.evidence["declarations"]] == ["D-24"]
    assert finding.evidence["declarations"][0]["locator"] == "p. 2, classification table"
    assert finding.source_locator == {"page": 3}
    assert finding.suggested_fix and not finding.suggested_fix.operations


@pytest.mark.parametrize("value,reason", [
    ("T30 RS", "fire_class_basis_unverified"),
    ("EI1 30-C5 Sa", "fire_class_basis_unverified"),
    ("EI2 60-C5", "fire_class_basis_unverified"),
    ("EI2 60-C5 S200", "fire_class_basis_unverified"),
    ("EI2 90-Sa C5", "higher_fire_class_needs_confirmation"),
    ("EI2 60-C5 Sa (opening face only)", "fire_class_unverified"),
    ("NPD", "fire_class_unverified"),
])
def test_different_or_unverified_designations_are_reviews(value, reason):
    finding, = findings("Brandschutztür EI₂ 60-C5 Sa", "", [declaration(value)])
    assert finding.severity == "info"
    assert finding.evidence["reason"] == reason
    assert finding.evidence["outcome"] == "insufficient_evidence"


@pytest.mark.parametrize("heading", ["Brandschutztür EI₂ 90-Sa C5", "Brandschutztür mindestens EI2 60-C5 Sa"])
def test_comparable_offered_class_satisfies_stated_class_or_explicit_minimum(heading):
    assert findings(heading, "", [declaration("EI2 90-C5 Sₐ")]) == []


def test_door_detail_keeps_the_qualifiers_omitted_from_the_heading():
    finding, = findings("Brandschutztür EI2 60", "Feuerwiderstand: EI2 60, Sa, C5.", [declaration("EI2 60")])
    assert finding.severity == "info"
    assert finding.evidence["reason"] == "fire_class_basis_unverified"
    assert finding.evidence["requirement"]["quote"] == "EI2 60, Sa, C5"


def test_typed_exact_attachment_does_not_assume_a_higher_class_is_accepted():
    finding, = findings("Brandschutztür", "", [declaration("EI2 90 Sa C5")], [schedule("EI2 60-C5 Sa")])
    assert finding.severity == "warning"
    assert finding.evidence["outcome"] == "conflict"
    assert finding.evidence["requirement"]["document"] == "Door Schedule"


def test_unrelated_or_disagreeing_declarations_do_not_prove_conflict():
    heading = "Brandschutztür EI2 60-C5 Sa"
    result, = findings(heading, "", [declaration("EI2 30-C5 Sa", "D-25")])
    assert result.evidence["declarations"] == []
    result, = findings(heading, "", [declaration("EI2 30-C5 Sa"), declaration("EI2 60-C5 Sa", revision="B")])
    assert result.evidence["reason"] == "fire_class_unverified"
    assert len(result.evidence["declarations"]) == 2


@pytest.mark.parametrize("heading,detail,offer", [
    ("Brandschutztür mit Zarge T60 RS", "", OFFER),
    ("Brandschutztür Typ E60", "", OFFER),
    ("Brandschutztür", "Zarge: Feuerwiderstand: EI2 60.", OFFER),
    ("Brandschutztür EI2 30 oder EI2 60", "", OFFER),
    ("Brandschutztür", "Feuerwiderstand: EI2 60, sofern erforderlich.", OFFER),
    ("Brandschutztür ausbauen", "Feuerwiderstand: EI2 60.", OFFER),
    ("Brandschutztür EI2 60-C5 Sa", "Fabrikat der Planung: Hersteller: Synthetic Doors; SKU: D-24\noder gleichwertig", ""),
    ("Brandschutztür EI2 60-C5 Sa", "", ""),
])
def test_scope_and_identity_controls(heading, detail, offer):
    assert findings(heading, detail, [declaration("EI2 30-C5 Sa")], offer=offer) == []


def test_attached_and_written_requirement_conflict_cites_both_and_holds_product_judgment():
    finding, = findings("Brandschutztür EI2 60-Sa C5", "", [declaration("EI2 30-C5 Sa")],
                        [schedule("EI₂ 30-C5 Sa")])
    assert finding.rule_id == REQUIREMENT_CONFLICT
    citations = finding.evidence["requirements"]
    assert {item.get("quote") for item in citations} == {"EI2 60-Sa C5", None}
    assert "Door Schedule" in {item["document"] for item in citations}


def test_attached_and_written_classes_collapse_when_they_use_equivalent_typography():
    finding, = findings("Brandschutztür EI2 60-Sa C5", "", [declaration("EI₂ 30-C5 Sa")],
                        [schedule("EI₂ 60-C5 Sa")])
    assert finding.rule_id == PROPERTY
    assert finding.evidence["requirement"]["document"] == "Door Schedule"


HEADING = "Brandschutztür EI2 60-C5 Sa"
WALL = "Wandmaterial: Trockenbauwand"


def test_matching_rating_for_another_wall_is_an_evidence_review():
    finding, = findings(HEADING, WALL, [installation_declaration("EI2 60-C5 Sa", "Stahlbetonwand", "125")])
    assert finding.severity == "info"
    assert finding.evidence["reason"] == "fire_wall_scope_unverified"
    assert finding.evidence["installation"]["support_quotes"] == [WALL]


def test_applicable_installation_precedes_class_comparison():
    detail = WALL + ". Wanddicke: 12,5 cm."
    evidence = [installation_declaration("EI2 60-C5 Sa", "Stahlbetonwand", "100"),
                installation_declaration("EI2 30-C5 Sa", "Trockenbauwand", "125", revision="B")]
    finding, = findings(HEADING, detail, evidence)
    assert finding.severity == "warning"
    assert finding.evidence["observed"] == "EI2 30 C5 SA"
    assert [item["revision"] for item in finding.evidence["declarations"]] == ["B"]
    assert finding.evidence["installation"]["thickness_quotes"] == ["Wanddicke: 12,5 cm"]


def test_below_all_declared_minimums_cites_the_written_wall_and_the_limits():
    detail = WALL + "\nWanddicke: 100 mm"
    evidence = [installation_declaration("EI2 60-C5 Sa", "Trockenbauwand", "15", "cm"),
                installation_declaration("EI2 60-C5 Sa", "Trockenbauwand", "12.5", "cm", revision="B")]
    finding, = findings(HEADING, detail, evidence)
    assert finding.severity == "warning"
    assert finding.evidence["reason"] == "fire_wall_below_minimum"
    assert Decimal(finding.evidence["installation"]["wall_thickness_mm"]) == 100
    assert [Decimal(value) for value in finding.evidence["installation"]["declared_minimum_thicknesses_mm"]] == [125, 150]
    assert finding.source_locator == {"page": 3}
    assert "125 mm" in finding.message
    assert finding.suggested_fix and not finding.suggested_fix.operations


@pytest.mark.parametrize("detail,declarations,reason", [
    (WALL + "\nWanddicke: ca. 125 mm", [installation_declaration("EI2 60-C5 Sa", "Trockenbauwand", "125")],
     "fire_wall_thickness_unverified"),
    (WALL + "\nWanddicke: 125 bis 150 mm", [installation_declaration("EI2 60-C5 Sa", "Trockenbauwand", "125")],
     "fire_wall_thickness_unverified"),
    (WALL + "\nWanddicke: 125 mm", [installation_declaration("EI2 60-C5 Sa", "Trockenbauwand", "12.5", "kg")],
     "fire_wall_thickness_unverified"),
    (WALL + "\nWanddicke: 125 mm", [installation_declaration("EI2 60-C5 Sa", "Trockenbauwand")],
     "fire_wall_thickness_unverified"),
    (WALL + "\nWanddicke: 125 mm", [declaration("EI2 60-C5 Sa")], "fire_wall_scope_unverified"),
    (WALL + "\nWandart: Mauerwerk", [installation_declaration("EI2 60-C5 Sa", "Trockenbauwand", "125")],
     "fire_wall_scope_unverified"),
    ("", [installation_declaration("EI2 60-C5 Sa", "Trockenbauwand", "125")], "fire_wall_scope_unverified"),
])
def test_incomplete_wall_scope_remains_a_review(detail, declarations, reason):
    finding, = findings(HEADING, detail, declarations)
    assert finding.severity == "info"
    assert finding.evidence["reason"] == reason


def test_class_and_installation_cannot_be_combined_across_declaration_rows():
    wall_only = installation_declaration("EI2 60-C5 Sa", "Trockenbauwand", "125", revision="B")
    wall_only["properties"].pop("fire_resistance_class")
    finding, = findings(HEADING, WALL + "\nWanddicke: 125 mm", [declaration("EI2 60-C5 Sa"), wall_only])
    assert finding.evidence["reason"] == "fire_wall_scope_unverified"


def test_clear_when_one_applicable_declaration_covers_the_wall_and_rating():
    detail = WALL + "\nWanddicke: 12,5 cm."
    evidence = [installation_declaration("EI2 30-C5 Sa", "Stahlbetonwand", "100"),
                installation_declaration("EI2 60-C5 Sa", "Trockenbauwand", "125", revision="B"),
                installation_declaration("EI2 30-C5 Sa", "Trockenbauwand", "150", revision="C")]
    assert findings(HEADING, detail, evidence) == []


@pytest.mark.parametrize("evidence,reason", [
    (declaration("EI2 30-C5 Sa"), "fire_wall_scope_unverified"),
    (installation_declaration("T 30 RS", "Trockenbauwand", "125"), "fire_wall_thickness_unverified"),
])
def test_repository_door_heading_can_anchor_synthetic_declaration_review(evidence, reason):
    path = Path(__file__).resolve().parents[3] / "data/tenders/LV_19_Sektionaltore_Stahltueren.pdf"
    original = from_bytes(path.name, path.read_bytes())
    assert not any(f.rule_id == PROPERTY for f in analyze(original, [1]).findings)
    line = next(line for line in original.lines if line.code.rstrip(".") == "1.2.40")
    detail, replacements = re.subn(r"Angebotenes Fabrikat: \.+$", OFFER, line.long_text, flags=re.M)
    assert replacements == 1
    offer = line.model_copy(update={"long_text": detail})
    snapshot = original.model_copy(update={"lines": [offer if item.id == line.id else item for item in original.lines],
                                           "declarations": [ProductDeclaration.model_validate(evidence)]})
    finding, = [item for item in analyze(snapshot, [1]).findings if item.rule_id == PROPERTY]
    assert finding.source_locator["page"] == 5
    assert finding.evidence["reason"] == reason
    assert finding.evidence["requirement"]["quote"] == "T 30 RS"
    assert finding.evidence["installation"]["thickness_quotes"] == ["Wanddicke: ca. 125 mm"]
