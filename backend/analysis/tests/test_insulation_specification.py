from pathlib import Path

import pytest

from analysis.adapter import from_bytes, from_data
from analysis.runner import analyze


def result(short, detail):
    source = from_data({"lines": [{"id": "eps", "code": "01.0010", "short_text": short, "long_text": detail,
                                   "quantity": 25, "unit": "m²", "source_locator": {"page": 4}}]})
    return analyze(source, [1])


def insulation_findings(report):
    assert not report.errors
    return [finding for finding in report.findings if str(finding.evidence.get("family")).startswith("insulation_")]


@pytest.mark.parametrize("heading,detail,property_name,basis,expected", [
    ("Dämmplatten EPS WLS 035", "WLS: 040.", "insulation_conductivity", "WLS", ("WLS 035", "WLS: 040")),
    ("Dämmplatten EPS WLG 035", "Wärmeleitgruppe: 040.", "insulation_conductivity", "WLG",
     ("WLG 035", "Wärmeleitgruppe: 040")),
    ("Dämmplatten EPS, Bemessungswert ≤ 0,035 W/(mK)", "Bemessungswert: 40 mW/(m·K).",
     "insulation_conductivity", "design", ("Bemessungswert ≤ 0,035 W/(mK)", "Bemessungswert: 40 mW/(m·K)")),
    ("Ausgleichsschicht, EPS, WLS 035, 80mm", "Dämmung: EPS. Plattendicke: 12 cm.",
     "insulation_thickness", "plate", ("80mm", "Plattendicke: 12 cm")),
])
def test_comparable_insulation_values_quote_the_source_and_ask_which_gates(heading, detail, property_name, basis, expected):
    report = result(heading, detail)
    item, = insulation_findings(report)
    assert item.evidence["family"] == property_name
    assert item.evidence["basis"] == basis
    assert (item.evidence["short_quote"], item.evidence["long_quote"]) == expected
    assert item.source_locator == {"page": 4}
    assert any(item.id in question.finding_ids for question in report.questions)
    assert item.suggested_fix and not item.suggested_fix.operations


@pytest.mark.parametrize("heading,detail", [
    ("Dämmplatten EPS WLS 035, 80 mm", "WLS: 035. Plattendicke: 8 cm."),
    ("Dämmplatten EPS, Bemessungswert: 0,035 W/(mK)", "λBW: 35 mW/(m·K)."),
    ("Dämmplatten EPS, Bemessungswert: 0,035 W/(mK)", "λD: 0,034 W/(mK)."),
    ("Dämmplatten EPS, Wärmeleitfähigkeit 0,035 W/(mK)", "U-Wert 0,25 W/(m²K)."),
    ("Dämmplatten EPS WLS 035", "Trittschalldämmung XPS: WLS 040."),
    ("Dämmplatten EPS WLS 035", "Einschließlich Randdämmstreifen mit WLS 040."),
    ("Dämmplatten EPS WLS 035", "WLS: 040 oder 035."),
    ("Dämmplatten EPS WLS 035", "WLS: 040–045."),
    ("Dämmplatten EPS höchstens WLS 040", "WLS 035."),
    ("Dämmplatten EPS, 160 mm gesamt", "Zweilagig. Plattendicke: 80 mm."),
    ("Dämmplatten EPS, 80 mm", "Plattendicke: 120 mm. Mehrlagig."),
    ("Dämmplatten EPS, 80 mm", "Plattendicke: 120 mm bis 140 mm."),
    ("Dämmplatten EPS, Lochdurchmesser 80 mm", "Plattendicke: 120 mm."),
    ("Dämmplatten EPS, höchstens 80 mm", "Plattendicke: 60 mm."),
])
def test_scope_limits_and_different_thermal_bases_stay_independent(heading, detail):
    assert insulation_findings(result(heading, detail)) == []


def test_original_screed_upload_has_a_plate_thickness_conflict():
    path = Path(__file__).resolve().parents[3] / "data/tenders/LV_18_Estrich.pdf"
    snapshot = from_bytes(path.name, path.read_bytes())
    report = analyze(snapshot, [1])
    finding, = [item for item in insulation_findings(report) if item.target.line_code.rstrip(".") == "11.4.10"]
    assert finding.evidence["short_quote"] == "80mm"
    assert finding.evidence["long_quote"] == "Plattendicke: 120 mm"
    assert finding.source_locator["page"] == 4


def test_screed_dependency_reviews_the_conflicting_underlay():
    snapshot = from_data({"lines": [
        {"id": "floor", "code": "01.0010", "short_text": "Zementestrich, schwimmend", "quantity": 50, "unit": "m²"},
        {"id": "eps", "code": "01.0020", "short_text": "Dämmplatten EPS, 80 mm",
         "long_text": "Dämmung: EPS. Plattendicke: 120 mm.", "quantity": 50, "unit": "m²"},
    ]})
    report = analyze(snapshot, [1, 2])
    review, = [finding for finding in report.findings if finding.rule_id.endswith("_NEEDS_UNDERLAYS_AND_INSULATION")]
    assert review.evidence["reason"] == "specification_not_assessable"
    assert review.evidence["specification_conflicts"][0]["line_code"] == "01.0020"
    assert not review.suggested_fix.operations
