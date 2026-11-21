from decimal import Decimal
from pathlib import Path

import pytest

from analysis.adapter import from_bytes, from_data
from analysis.runner import analyze


def cable_findings(snapshot):
    result = analyze(snapshot, [1])
    assert not result.errors
    return result, [f for f in result.findings if f.evidence.get("family") == "cable_conductors"]


def tender(heading, detail):
    return from_data({"lines": [{"id": "cable", "code": "01.0010", "short_text": heading, "long_text": detail,
                                 "quantity": "80", "unit": "m", "source_locator": {"page": 2}}]})


@pytest.mark.parametrize("heading,detail,field,a,b", [
    ("Energiekabel NYCWY 4 x 50/25mm²", "Energiekabel NYCWY 4×50 SM/16 mm2", "concentric_section_mm2", 25, 16),
    ("Erdverbindungskabel NYY 7 x 1,5 mm²", "ErdverbindungskabelNYY 5 x 1,5 mm², ### VK-ER-7",
     "cores", 7, 5),
    ("PVC-Mantelleitung NYM-J 3 G 1,5", "Kabeltyp: NYM-J 3 x 2,5 mm²", "core_section_mm2", "1.5", "2.5"),
    ("Energiekabel NYY-J 5×10", "Energiekabel NYY-O 5 x 10", "variant", "J", "O"),
])
def test_conflicts_show_the_specific_cable_values_and_bidder_question(heading, detail, field, a, b):
    result, findings = cable_findings(tender(heading, detail))
    finding, = findings
    assert finding.rule_id == "L1.TEXT.VALUE_CONFLICT"
    assert finding.severity == "warning"
    assert finding.evidence["different_fields"] == [field]
    assert finding.evidence["short_quote"] in heading
    assert finding.evidence["long_quote"] in detail
    values = [finding.evidence[key][field] for key in ("short_cable", "long_cable")]
    if field.endswith("_mm2"):
        assert [Decimal(value) for value in values] == [Decimal(a), Decimal(b)]
    else:
        assert values == [a, b]
    assert finding.source_locator == {"page": 2}
    assert any(finding.id in item.finding_ids and "Kabelliste" in item.text_de for item in result.questions)
    assert finding.suggested_fix and not finding.suggested_fix.operations


@pytest.mark.parametrize("heading,detail", [
    ("NYM-J 3x1,5", "NYM-J 3 × 1.50 mm²"),
    ("NYCWY 4x50/25", "NYCWY 4 x 50 SM"),
    ("NYCWY 4x50/25", "NYCWY 4x50/25. Mit Anschluss an NYCWY 4x25/16."),
    ("NYCWY 4x50/25", "Anschlusskasten für NYCWY 4x25/16."),
    ("NYCWY 4x50/25", "Kabel NYY 4x25"),
    ("NYM-J 3x1,5", "NYM-J 3x2,5 oder NYM-J 3x1,5"),
    ("NYM-J 3x1,5", "NYM-J 3x2,5. Kabel NYM-J 3x1,5."),
    ("NYM-J 3x1,5", "NYM-J 3x2,5 mm"),
    ("NYM-J 3x1,5", "NYM-J 3x2,5 und 5x2,5"),
    ("NYM-J 3x1,5", "NYM-J 3x2,5/1,5"),
    ("NYM-J 3x1,5", "NYM-J 3x2,5A"),
])
def test_cable_scope_and_notation_controls(heading, detail):
    assert cable_findings(tender(heading, detail))[1] == []


@pytest.mark.parametrize("name,code,locator,old,new,key", [
    ("LV_13_ELT.pdf", "1.3.1.1", {"page": 8}, "50/25", "50/16", "concentric_section_mm2"),
    ("StBALV23040.D86", "09.01.0009", {"record": 4276}, "7 x 1,5", "5 x 1,5", "cores"),
])
def test_repository_controls_and_edited_details_keep_original_locators(name, code, locator, old, new, key):
    path = Path(__file__).resolve().parents[3] / "data/tenders" / name
    original = from_bytes(name, path.read_bytes())
    assert cable_findings(original)[1] == []
    line = next(item for item in original.lines if item.code == code)
    assert old in line.long_text
    # Native printed PDF detail retains a copied heading followed by the real
    # description. Change only the last occurrence to leave the duplicate intact.
    prefix, _, suffix = line.long_text.rpartition(old)
    mutated = line.model_copy(update={"long_text": prefix + new + suffix})
    alternate = original.model_copy(update={"lines": [mutated if item.id == line.id else item for item in original.lines]})
    changed, = cable_findings(alternate)[1]
    assert changed.target.line_code == code
    assert changed.evidence["different_fields"] == [key]
    assert all(changed.source_locator[field] == value for field, value in locator.items())
