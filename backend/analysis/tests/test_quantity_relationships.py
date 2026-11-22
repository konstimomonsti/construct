from decimal import Decimal
import json

import pytest

from analysis.adapter import from_data
from analysis.bid_pricing import quantity_opportunities
from analysis.layer3.prompts import RELATIONSHIP_VERSION
from analysis.layer3.provider import FakeProvider, ProviderUnavailable
from analysis.quantity_relationships import RULE_ID
from analysis.runner import analyze

QUOTE = "Je Leuchte sind zwei Halter zu liefern."
BASE = {"id": "base", "code": "1.10", "short_text": "Leuchte", "quantity": 10, "unit": "St"}
TARGET = {"id": "target", "code": "1.20", "short_text": "Halter", "quantity": 9, "unit": "St"}


def assess(text=QUOTE, *, target=TARGET, extra_lines=(), **changes):
    snapshot = from_data({"lines": [{**BASE, "long_text": text}, *([target] if target else []), *extra_lines]})
    proposal = {"source_ref": "P1", "quote": text, "base_ref": "P1", "base_item": "Leuchte",
                "dependent_ref": "P2" if target else None, "dependent_item": "Halter", "ratio": "2",
                "qualifier": None, **changes}
    provider = FakeProvider(lambda request: {"relationships": [proposal]} if request.prompt_version == RELATIONSHIP_VERSION
                            else {key: [] for key in request.schema["required"]})
    return snapshot, analyze(snapshot, (1, 2, 3), layer3_provider=provider), provider


def test_german_relationship_uses_word_number_and_links_both_positions():
    snapshot, result, provider = assess()
    opportunity, = quantity_opportunities(snapshot, result)
    finding, = [item for item in result.findings if item.rule_id == RULE_ID]
    assert opportunity["quantity"] == Decimal(11)
    assert finding.target.line_id == "target"
    assert finding.related_line_ids == ["base"]
    assert QUOTE in finding.message
    assert finding.evidence["calculation"] == "10 × 2 = 20 required, 9 listed, +11 St"
    request = next(request for request in provider.requests if request.prompt_version == RELATIONSHIP_VERSION)
    assert json.loads(request.prompt)[0]["long_text"] == QUOTE
    # Pricing re-verifies evidence rather than trusting a reported difference or changed ratio.
    finding.evidence["extra_quantity"] = "1000"
    assert quantity_opportunities(snapshot, result)[0]["quantity"] == 11
    finding.evidence["relationship"]["ratio"] = "3"
    assert quantity_opportunities(snapshot, result) == []


@pytest.mark.parametrize(("text", "target", "changes", "reason"), [
    (QUOTE, {**TARGET, "quantity": 20}, {}, None),
    ("Je Leuchte sind zwei Halter enthalten.", TARGET, {}, "qualified_scope"),
    ("Je Leuchte bei Bedarf zwei Halter vorsehen.", TARGET, {}, "qualified_scope"),
    ("Halter je Leuchte, Verhältnis bitte bestätigen.", TARGET, {"ratio": None}, "assumption"),
    (QUOTE, None, {}, "missing_position"),
    (QUOTE, {**TARGET, "unit": "m"}, {}, "incompatible_units"),
    (QUOTE, {**TARGET, "pricing_basis": "lump_sum"}, {}, "missing_rate_position"),
    (QUOTE, {**TARGET, "total_rule": "conditional"}, {}, "qualified_scope"),
    (QUOTE, TARGET, {"quote": "Je Leuchte sind zwei Halter zusätzlich zu liefern."}, None),
    (QUOTE, TARGET, {"ratio": "12"}, None),
    (QUOTE + " Je Leuchte sind drei Halter zu liefern.", TARGET, {"quote": QUOTE}, "conflict"),
])
def test_unsafe_or_covered_relationship_does_not_become_a_priced_change(text, target, changes, reason):
    snapshot, result, _ = assess(text, target=target, **changes)
    assert quantity_opportunities(snapshot, result) == []
    findings = [f for f in result.findings if f.rule_id == RULE_ID]
    assert [f.evidence["reason"] for f in findings] == ([reason] if reason else [])
    if reason:
        assert any(question.rule_id == RULE_ID for question in result.questions)


def test_competing_rooms_need_resolved_scope():
    competing = {**TARGET, "id": "target-b", "code": "1.30", "long_text": "Raum B"}
    target_a = {**TARGET, "long_text": "Raum A"}
    snapshot, result, _ = assess(target=target_a, extra_lines=[competing])
    assert not quantity_opportunities(snapshot, result)
    assert any(f.evidence.get("reason") == "ambiguous_scope" for f in result.findings)
    snapshot, result, _ = assess(QUOTE + " Raum A.", target=target_a, extra_lines=[competing])
    assert quantity_opportunities(snapshot, result)[0]["position_id"] == "target"


def test_explicit_ref_crosses_batch_boundary_and_session_limits_still_apply(monkeypatch):
    monkeypatch.setenv("ANALYSIS_L3_MAX_BATCH_LINES", "2")
    unrelated = [{"id": f"filler-{index}", "code": f"1.2{index}", "short_text": "Cable", "quantity": 10, "unit": "m"}
                 for index in range(8)]
    snapshot, result, provider = assess("Je Leuchte sind zwei Halter (Pos. 1.90) zu liefern.",
                                        target=None, extra_lines=[*unrelated, {**TARGET, "code": "1.90"}],
                                        dependent_ref="P10")
    payload = json.loads(next(r.prompt for r in provider.requests if r.prompt_version == RELATIONSHIP_VERSION))
    assert [item["ref"] for item in payload] == ["P1", "P10"]
    assert quantity_opportunities(snapshot, result)[0]["quantity"] == 11
    monkeypatch.setenv("ANALYSIS_L3_MAX_CALLS", "0")
    snapshot, result, provider = assess()
    assert provider.requests == []
    assert not quantity_opportunities(snapshot, result)
    assert "L3.QTY.RELATIONSHIP×1" in next(e for e in result.errors if e.startswith("layer 3 coverage:"))


def test_unavailable_provider_keeps_the_sanitary_shortfall():
    from analysis.tests.test_bid_pricing import EXAMPLES
    from analysis.adapter import from_file

    snapshot = from_file(EXAMPLES / "sanitary.X83")
    result = analyze(snapshot, (1, 2, 3), layer3_provider=FakeProvider(lambda _: ProviderUnavailable("offline")))
    assert quantity_opportunities(snapshot, result)[0]["quantity"] == 7
