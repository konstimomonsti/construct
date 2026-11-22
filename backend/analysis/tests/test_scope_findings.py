"""Source and coverage regressions for two focused scope checks."""

from pathlib import Path

import pytest

from analysis.adapter import from_data, from_file
from analysis.runner import analyze

DATA = Path(__file__).resolve().parents[3] / "data" / "tenders"
DN_RULE = "L1.TEXT.VALUE_CONFLICT"
TEST_RULE = "L2.DRAINAGE.EXPLICIT_LEAK_TEST"


@pytest.mark.parametrize(("short", "long", "severity"), [
    ("Abwasserrohr DN 125", "Abwasserrohr DN 100 liefern.", "warning"),
    ("Losflansch DN 125", "Losflansch, DN 100, PN 10", "warning"),
    ("Rohr DN 100", "Flansch DN 125 mitliefern.", "info"),
    ("Rohr DN 100", "Rohr DN 100 an das bestehende Rohr DN 125 anschließen.", None),
    ("Rohr DN 100", "Rohr DN 100 liefern.", None),
])
def test_dn_severity_depends_on_a_single_size_for_the_same_component(short, long, severity):
    source = from_data({"lines": [{"id": "pipe", "code": "1", "short_text": short, "long_text": long}]})
    findings = [f for f in analyze(source, (1,)).findings if f.rule_id == DN_RULE]
    assert [f.severity for f in findings] == ([severity] if severity else [])


@pytest.mark.parametrize(("followup", "test", "severity"), [
    ("", None, "warning"),
    ("", {"short_text": "Dichtheitsprüfung für Pos. 01.0001"}, None),
    ("", {"short_text": "Dichtheitsprüfung für Pos. 01.0003"}, "warning"),
    ("", {"short_text": "Dichtheitsprüfung für Pos. 01.0001", "quantity": 0}, "warning"),
    ("", {"short_text": "Dichtheitsprüfung für Pos. 01.0001", "total_rule": "conditional"}, "warning"),
    ("", {"short_text": "Dichtheitsprüfung Abwasserleitungen"}, "info"),
    (" Die Prüfung erfolgt bauseits.", None, None),
])
def test_separate_leak_test_reports_only_uncovered_or_unassigned_work(followup, test, severity):
    lines = [{"id": "pipe", "code": "1.1", "quantity": 10, "unit": "m", "short_text": "Abwasserrohr DN 150",
              "long_text": f"Endreinigung bauseits. Dichtheitsprüfung ist separat durchzuführen.{followup}"}]
    if test:
        lines.append({"id": "test", "code": "1.2", "quantity": 1, "unit": "ea", **test})
    result = analyze(from_data({"project": {"gaeb_phase": "83"}, "lines": lines}))
    findings = [f for f in result.findings if f.rule_id == TEST_RULE]
    assert not result.errors
    assert [f.severity for f in findings] == ([severity] if severity else [])
    if findings:
        assert findings[0].evidence["trigger_line_ids"] == ["pipe"]
        assert findings[0].evidence["quote"] == "Dichtheitsprüfung ist separat durchzuführen"
        assert any(TEST_RULE == question.rule_id for question in result.questions)


@pytest.mark.parametrize("suffix", ["D83", "X83"])
def test_real_tender_has_two_actionable_dn_conflicts(suffix):
    source = from_file(DATA / f"8209.003_Leistungsverzeichnis_leer.{suffix}")
    result = analyze(source)
    assert not result.errors
    warnings = {f.target.line_code for f in result.findings
                if f.rule_id == DN_RULE and f.severity == "warning" and f.evidence["family"] == "DN"}
    assert warnings == {"05.01.4", "05.01.46"}
