from pathlib import Path

import pytest

from analysis.adapter import from_bytes, from_data
from analysis.runner import analyze


def issues(short, long):
    snapshot = from_data({"lines": [{"id": "item", "code": "01.0010", "short_text": short,
                                     "long_text": long, "quantity": 2, "unit": "St"}]})
    result = analyze(snapshot, [1])
    assert not result.errors
    return [f for f in result.findings if f.rule_id == "L1.DIN.FIRE_RATING_CONFLICT" or f.evidence.get("family") == "fire"]


@pytest.mark.parametrize("short,long", [
    ("Brandschutztür T30", "Anschluss an Wand F90."),
    ("Wand F30", "Wand F30. Decke F90."),
    ("Wand F30", "Nachbarwand F90."),
    ("Brandschutztür T30", "Wand F90. Zarge: T90."),
    ("Brandschutztür T30", "Zarge montieren. Feuerwiderstand: T90."),
    ("Brandschutztür T30", "Feuerwiderstand: T30. Zarge T90."),
    ("W112 Metallständerwand, F30", "Wand F30. Türöffnung für Wand F90."),
    ("Brandwand gemäß Brandschutzkonzept B-01", ""),
    ("Brandschutzwand", "Brandwand EI 60."),
    ("Brandschutztür mindestens EI2 30-C5 Sa", "Feuerwiderstand: EI2 60-C5 Sa."),
])
def test_compatible_or_separate_fire_designations(short, long):
    assert issues(short, long) == []


@pytest.mark.parametrize("short,long,expected,severity", [
    ("W112 Metallständerwand F30", "Brandschutz: F60.", ("F30", "F60"), "error"),
    ("Brandschutztür EI₂ 30-C5 Sa", "Feuerwiderstand: EI2 60-C5 Sa.", ("EI₂ 30-C5 Sa", "EI2 60-C5 Sa"), "warning"),
    ("Brandschutztür T30", "Feuerwiderstand: EI₂ 30.", ("T30", "EI₂ 30"), "info"),
    ("Brandwand F90", "Brandschutz: REI 90.", ("F90", "REI 90"), "info"),
])
def test_conflicting_attributed_values_get_one_source_question(short, long, expected, severity):
    finding, = issues(short, long)
    assert finding.severity == severity
    assert (finding.evidence["short_quote"], finding.evidence["long_quote"]) == expected
    assert all(quote in finding.evidence["bieterfrage_de"] for quote in expected)
    assert finding.suggested_fix and not finding.suggested_fix.operations


def test_wall_missing_class_when_only_another_components_class_is_given():
    finding, = issues("Brandwand", "Türöffnung mit T30-Tür. Decke REI 60.")
    assert finding.evidence["outcome"] == "missing"


def test_repository_drywall_rating_control_and_edited_detail_keep_page():
    path = Path(__file__).resolve().parents[3] / "data/tenders/LV_17_Trockenbau.pdf"
    original = from_bytes(path.name, path.read_bytes())
    line = next(line for line in original.lines if line.code.rstrip(".") == "10.1.30")
    clean = analyze(original.model_copy(update={"lines": [line]}), [1])
    assert not any(f.rule_id == "L1.DIN.FIRE_RATING_CONFLICT" for f in clean.findings)
    assert "Brandschutz: F30" in line.long_text
    changed = line.model_copy(update={"long_text": line.long_text.replace("Brandschutz: F30", "Brandschutz: F60")})
    result = analyze(original.model_copy(update={"lines": [changed]}), [1])
    finding, = [f for f in result.findings if f.rule_id == "L1.DIN.FIRE_RATING_CONFLICT"]
    assert finding.evidence["short_quote"] == "F30"
    assert finding.evidence["long_quote"] == "F60"
    assert finding.source_locator == line.source_locator
