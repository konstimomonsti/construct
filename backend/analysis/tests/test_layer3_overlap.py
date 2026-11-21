"""Evidence and candidate controls for the semantic overlap check."""

from decimal import Decimal
import json

import pytest

from analysis import adapter, layer3
from analysis.contracts import AnalysisInput, Line
from analysis.layer3.checks.overlap import RULE_ID, VERSION, candidates
from analysis.layer3.provider import FakeProvider, ResponseCache
from analysis.runner import analyze
from test_layer1 import DATA

FIRST = Line(id="a", code="1.10", section_id="civil", sort_order=0, unit="m³", quantity=Decimal(32),
             short_text="Baugrubenaushub, Bodenklasse 3 bis 5",
             long_text="Baugrube und Fundamentgräben lösen, laden und seitlich lagern. Abrechnung nach m3.",
             source_locator={"page": 1})
SECOND = Line(id="b", code="1.20", section_id="civil", sort_order=1, unit="m³", quantity=Decimal(32),
              short_text="Bodenklasse 3 bis 5, Baugrubenaushub",
              long_text="Baugrubenbereich und Fundamentgräben lösen, laden und seitlich lagern. Abrechnung nach m3.",
              source_locator={"page": 2})


def test_overlap_requires_quotes_and_points_to_both_sources():
    snapshot = AnalysisInput(lines=[FIRST, SECOND])
    seen = []

    def answer(request):
        if request.prompt_version != VERSION:
            return {"findings": []}
        pair, = json.loads(request.prompt)
        seen.append(pair["ref"])
        return {"findings": [
            {"ref": "unknown", "first_quote": FIRST.short_text, "second_quote": SECOND.short_text},
            {"ref": pair["ref"], "first_quote": FIRST.short_text, "second_quote": "invented work"},
            {"ref": pair["ref"], "first_quote": "Abrechnung nach m3", "second_quote": SECOND.short_text},
            {"ref": pair["ref"], "first_quote": FIRST.short_text, "second_quote": SECOND.short_text},
        ]}

    errors = []
    findings = layer3.run(snapshot, [], errors, provider=FakeProvider(answer), cache=ResponseCache(None))
    assert not errors and len(seen) == 1
    finding, = [f for f in findings if f.rule_id == RULE_ID]
    assert finding.target.line_code == SECOND.code and finding.source_locator == {"page": 2}
    assert finding.related_line_ids == [FIRST.id]
    assert finding.evidence["related_source_locator"] == {"page": 1}
    assert finding.evidence["first_quote"] == FIRST.short_text
    assert finding.suggested_fix.operations == []
    assert "takeoff" in finding.suggested_fix.rationale


def test_overlap_excludes_incompatible_items_and_prior_pair_findings():
    for changes in ({"quantity": Decimal(31)}, {"section_id": "different"}, {"total_rule": "alternative"},
                    {"short_text": "Bodenklasse 3 bis 6, Baugrubenaushub"}):
        assert list(candidates([FIRST, SECOND.model_copy(update=changes)], [])) == []
    exact = SECOND.model_copy(update={"short_text": FIRST.short_text, "long_text": FIRST.long_text})
    prior = analyze(AnalysisInput(lines=[FIRST, exact]), [1]).findings
    reworded = SECOND.model_copy(update={
        "long_text": "Baugrube und Fundamentgräben lösen, laden und danach lagern. Abrechnung nach m3.",
    })
    assert list(candidates([FIRST, reworded], prior)) == []


@pytest.mark.parametrize("filename", [
    "StBALV23040.D86", "8209.003_Leistungsverzeichnis_leer.X83",
    "8209.003_Leistungsverzeichnis_leer.D83", "[ORT_024] LV24069.D86", "501-24-01_GAEB-XML_sas.x83",
])
def test_tender_technical_variants_stay_separate(filename):
    snapshot = adapter.from_file(DATA / filename)
    prior = analyze(snapshot, [1, 2])
    assert not prior.errors
    assert list(candidates(snapshot.lines, prior.findings)) == []
