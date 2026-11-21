from pathlib import Path

import pytest

from analysis.contracts import AnalysisInput
from analysis.runner import analyze
from analysis.layer1.textvalues import EXPOSURE
from test_layer1 import make_line, run


def din(text, phase="83"):
    result = run(make_line(short_text=text, long_text=""), phase=phase)
    assert not result.errors
    return [f for f in result.findings if f.rule_id.startswith("L1.DIN.")]


@pytest.mark.parametrize("phase", ["83", "84", "86"])
def test_exposure_minimum_and_phase(phase):
    findings = din("Beton C 20 / 25, XC2 XF2", phase)
    error = next(f for f in findings if f.rule_id.endswith("EXPOSURE_STRENGTH"))
    assert error.severity == "error"
    assert error.evidence["din"] == {"grade": "C20/25", "exposure": ["XC2", "XF2"], "required_min": "C25/30"}
    assert error.evidence["bieterfrage_de"].startswith("Zu Pos. 01.0001:")
    assert not any(f.rule_id.endswith("EXPOSURE_STRENGTH") for f in din("Beton C25/30 XF2"))


@pytest.mark.parametrize("grade", ["C99/123", "C30/35"])
def test_unknown_grade_is_not_ranked(grade):
    findings = din(f"Beton {grade} XD3")
    assert [f.rule_id for f in findings] == ["L1.DIN.UNKNOWN_GRADE"]
    assert findings[0].severity == "warning"
    assert din("Beton C35/45 XC2") == []


@pytest.mark.parametrize("text", ["Beton LC 20 / 22 XD3", "UHPC C80/95 XC4 XD3 XF4", "Sauberkeitsschicht C8/10",
                                  "Wasserbausteine C 200/400 liefern", "Auflager C12/15, Stärke 20 cm"])
def test_standard_or_non_concrete_grades_are_not_unknown(text):
    assert not any(f.rule_id == "L1.DIN.UNKNOWN_GRADE" for f in din(text))


def test_low_standard_grade_is_ranked():
    findings = din("Fundament C12/15, XC2 XF1")
    assert {f.evidence["exposure"] for f in findings if f.rule_id.endswith("EXPOSURE_STRENGTH")} == {"XC2", "XF1"}


def test_lowercase_words_are_not_exposure_classes():
    assert EXPOSURE.findall("Leerrohre wo erforderlich, ws. siehe Plan") == []
    assert din("Beton C35/45, Einbau wo erforderlich") == []


def test_special_notes_are_unique_and_stable():
    findings = din("Beton C35/45 XF2 XF2 XF4 WA")
    assert len(findings) == 3
    assert {f.evidence["exposure"] for f in findings} == {"XF2", "XF4", "WA"}
    assert len({f.id for f in findings}) == 3
    assert all(f.severity == "info" and "din" in f.evidence for f in findings)
    assert [f.id for f in findings] == [f.id for f in din("Beton C35/45 XF2 XF2 XF4 WA")]
    assert din("Beton C35/45 XC2") == []


def test_exposure_boundaries_and_ambiguous_classes():
    assert set(EXPOSURE.findall("XC1 XC4 XD3 XS3 XF4 XA3 XM3 WO WF WA WS")) == {
        "XC1", "XC4", "XD3", "XS3", "XF4", "XA3", "XM3", "WO", "WF", "WA", "WS"}
    assert din("Beton C20/25 XC20 WAND XF20") == []
    assert not any(f.rule_id.endswith("EXPOSURE_STRENGTH") for f in din("C20/25 C35/45 XD3"))
    assert din("Beton C20/25 XA3 XM3 WO WF WS") == []  # no invented minima
    assert din("Schubsicherung mit Bild /WA/WF/") == []



def test_grade_exposure_for_distinct_components_stays_local():
    failures = [f for f in din("Fundament C20/25 XC2. Bettung C25/30 XF2. Rückenstütze C20/25 XF4.")
                if f.rule_id == "L1.DIN.EXPOSURE_STRENGTH"]
    finding, = failures
    assert finding.evidence["components"] == ["rückenstütze"]
    assert finding.evidence["grade_quote"] == "Rückenstütze C20/25"
    assert finding.evidence["exposure_quote"] == "XF4"
    assert finding.evidence["din"]["grade"] == "C20/25"
    assert finding.suggested_fix.rationale and not finding.suggested_fix.operations


def test_exposure_on_other_component_asks_for_its_grade():
    findings = din("Fundament C20/25. Bettung: Expositionsklasse XF4.")
    assert {f.rule_id for f in findings} == {"L1.DIN.EXPOSURE_SCOPE", "L1.DIN.NOTE"}
    question = next(f for f in findings if f.rule_id.endswith("EXPOSURE_SCOPE"))
    assert question.evidence["components"] == ["bettung"]
    assert question.evidence["exposure_quote"] == "Expositionsklasse XF4"
    assert question.evidence["din"]["grade"] is None
    assert question.suggested_fix


def test_separate_exposure_attribute_links_only_to_matching_component():
    result = run(make_line(short_text="Fundament C20/25. Bettung C35/45.",
                           long_text="Bettung: Expositionsklasse XC2. Fundament: Expositionsklasse XD3."))
    failure, = [f for f in result.findings if f.rule_id == "L1.DIN.EXPOSURE_STRENGTH"]
    assert failure.evidence["grade_field"] == "short_text"
    assert failure.evidence["exposure_field"] == "long_text"
    assert failure.evidence["components"] == ["fundament"]
    assert failure.evidence["exposure_quote"] == "Expositionsklasse XD3"


@pytest.mark.parametrize("text", [
    "C35/45 C20/25 XD3",
    "Fundament C35/45 oder C20/25 XD3.",
    "Fundament C35/45 / C20/25 XD3.",
])
def test_unattributed_or_alternative_grades_do_not_produce_a_definite_failure(text):
    assert [f.rule_id for f in din(text)] == ["L1.DIN.EXPOSURE_SCOPE"]


def test_exposure_note_quotes_only_the_linked_component():
    note, = din("Fundament C20/25 XC2. Bettung: 20 cm Normalbeton C25/30 (LP) XF2.")
    assert note.rule_id == "L1.DIN.NOTE"
    assert note.evidence["components"] == ["bettung"]
    assert note.evidence["din"]["grade"] == "C25/30"
    assert note.evidence["grade_quote"] == "Bettung: 20 cm Normalbeton C25/30"


def test_lv11_golden_and_mutations():
    source = AnalysisInput.model_validate_json((Path(__file__).parent / "fixtures/lv11_precast.json").read_text(encoding="utf-8"))
    result = analyze(source, [1, 2])
    assert not result.errors
    notes = [f for f in result.findings if f.rule_id == "L1.DIN.NOTE"]
    assert {(f.target.line_code, f.evidence["exposure"]) for f in notes} == {
        (f"3.2.{n}", exposure) for n in (20, 30, 40, 50, 60) for exposure in ("XF2", "WA")}
    assert not any(f.rule_id in {"L1.DIN.EXPOSURE_STRENGTH", "L1.PRECAST.LAYER_SUM"} for f in result.findings)
    for rule_id, codes in {
        "L1.UNIT.TRADE_MISMATCH": {"3.2.80"},
        "L1.TEXT.SPEC_PLACEHOLDER": {"3.2.80", "3.2.90"},
    }.items():
        assert {f.target.line_code for f in result.findings if f.rule_id == rule_id} == codes
    assert not any(f.rule_id.startswith("L2.PRECAST.") for f in result.findings)
    mutated = source.model_copy(deep=True)
    mutated.lines[1].long_text = mutated.lines[1].long_text.replace("C35/45", "C20/25").replace("d= 8 cm", "d= 10 cm")
    changed = analyze(mutated, [1])
    assert {"L1.DIN.EXPOSURE_STRENGTH", "L1.PRECAST.LAYER_SUM"} <= {
        f.rule_id for f in changed.findings if f.target.line_code == "3.2.20"}
