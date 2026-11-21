"""Layer 3 tests. No network: every model answer comes from FakeProvider."""

import json
import re

import pytest

from analysis import layer3
from analysis.layer2.adapter import from_data
from analysis.layer3.provider import (
    FakeProvider, LLMRequest, OllamaProvider, ProviderError, ProviderUnavailable, ResponseCache, provider_from_env,
)
from analysis.layer3.prompts import CONTRADICTION_VERSION
from analysis.layer3.schema import CONTRADICTION_SCHEMA, L2_CONFIRM_SCHEMA, MAX_CONFIDENCE, quote_in
from analysis.registry import rules_for
from analysis.runner import analyze

CONTRA = "L3.TEXT.SHORT_LONG_CONTRADICTION"
CONFIRM = "L3.REVIEW.L2_CONFIRM"


def line(id, short, long=None, quantity="10", unit="m", **kwargs):
    return {"id": id, "code": id, "short_text": short, "long_text": long, "quantity": quantity, "unit": unit,
            **kwargs}


def pipe_input():
    return from_data({"lines": [
        line("01.0010", "PVC-Rohr DN 150 verlegen", "Kanalrohr aus PVC-U, DN 200, SN 8, in vorhandenem Graben verlegen."),
        line("01.0020", "Schacht DN 1000", "Schacht DN 1000 aus Betonfertigteilen herstellen.", unit="St"),
        line("01.0030", "Baustelle einrichten", "Baustelle einrichten und räumen.", quantity="1", unit="psch"),
    ]})


def contradiction_answer(request):
    """Report the first item whose short text says DN 150 and long text DN 200 (other checks: nothing)."""
    if request.prompt_version != CONTRADICTION_VERSION:
        return {"findings": [], "items": [], "reviews": []}
    items = json.loads(request.prompt.split("\n\n", 1)[1])["items"]
    findings = []
    for item in items:
        if "DN 150" in item["short_text"] and "DN 200" in (item["long_text"] or ""):
            findings.append({"line_ref": item["ref"], "property": "nominal diameter", "short_quote": "DN 150",
                             "long_quote": "DN 200", "message": "Short text says DN 150, long text DN 200.",
                             "confidence": 0.95})
    return {"findings": findings}


def run3(analysis_input, provider, prior=None, **kwargs):
    errors = []
    findings = layer3.run(analysis_input, prior or [], errors, provider=provider, cache=ResponseCache(None),
                          **kwargs)
    return findings, errors


def sent(provider, version=CONTRADICTION_VERSION):
    """The requests of one check (the other layer 3 checks also run on these inputs)."""
    return [request for request in provider.requests if request.prompt_version == version]


def by_rule(findings, rule_id):
    return [finding for finding in findings if finding.rule_id == rule_id]


def complete_coverage(errors):
    return len(errors) == 1 and re.fullmatch(r"layer 3 coverage: (\d+)/\1 batches", errors[0]) is not None


# --------------------------------------------------------------------------- registration and helpers


def test_rules_registered_on_layer_3():
    ids = {info.rule_id for info in rules_for(3)}
    assert {CONTRA, CONFIRM} <= ids


def test_quote_check_ignores_whitespace_case_and_line_hyphens():
    text = "Geräte, die zur Ausführung erforder- lich sind,  DN 200"
    assert quote_in("erforderlich sind", text)
    assert quote_in("dn   200", text)
    assert not quote_in("DN 250", text)
    assert not quote_in("...", text)
    assert not quote_in("", text)


def test_schemas_are_strict_objects():
    for schema in (CONTRADICTION_SCHEMA, L2_CONFIRM_SCHEMA):
        item = next(iter(schema["properties"].values()))["items"]
        assert item["additionalProperties"] is False
        assert set(item["required"]) == set(item["properties"])


def test_cache_key_depends_on_model_prompt_version_and_text():
    request = LLMRequest("sys", "prompt", {"type": "object"}, "v1")
    assert request.cache_key("a") == LLMRequest("sys", "prompt", {"type": "object"}, "v1").cache_key("a")
    assert request.cache_key("a") != request.cache_key("b")
    assert request.cache_key("a") != LLMRequest("sys", "prompt", {"type": "object"}, "v2").cache_key("a")
    assert request.cache_key("a") != LLMRequest("sys", "prompt 2", {"type": "object"}, "v1").cache_key("a")


# --------------------------------------------------------------------------- contradictions


def test_contradiction_found_with_verified_quotes():
    findings, errors = run3(pipe_input(), FakeProvider(contradiction_answer))
    found = by_rule(findings, CONTRA)
    assert complete_coverage(errors)
    assert len(found) == 1
    finding = found[0]
    assert finding.target.line_code == "01.0010"
    assert finding.severity == "warning" and finding.layer == 3
    assert finding.origin == "llm" and finding.model == "fake"
    assert finding.evidence["short_quote"] == "DN 150" and finding.evidence["long_quote"] == "DN 200"
    assert finding.evidence["confidence"] == MAX_CONFIDENCE
    assert finding.evidence["prompt_version"].startswith("l3-contradiction-")
    assert finding.suggested_fix is None


def test_prefilter_sends_only_lines_with_values_and_two_texts():
    provider = FakeProvider(lambda request: {"findings": []})
    analysis_input = from_data({"lines": [
        line("a", "PVC-Rohr DN 150", "PVC-Rohr DN 150 verlegen."),
        line("b", "Baustelle einrichten", "Baustelle einrichten und räumen."),  # no value in the short text
        line("c", "Rohr DN 100", None),                                           # no long text
        line("d", "Rohr DN 100", "Rohr DN 100"),                                  # identical texts
    ]})
    run3(analysis_input, provider)
    assert len(sent(provider)) == 1
    items = json.loads(sent(provider)[0].prompt.split("\n\n", 1)[1])["items"]
    assert [item["code"] for item in items] == ["a"]


@pytest.mark.parametrize("bad", [
    {"line_ref": "#9", "short_quote": "DN 150", "long_quote": "DN 200"},          # unknown ref
    {"line_ref": "#1", "short_quote": "DN 125", "long_quote": "DN 200"},          # not in the short text
    {"line_ref": "#1", "short_quote": "DN 150", "long_quote": "DN 250"},          # not in the long text
    {"line_ref": "#1", "short_quote": "PVC", "long_quote": "PVC"},                # same value
])
def test_hallucinated_contradictions_are_dropped(bad):
    answer = {"findings": [{"property": "x", "message": "m", "confidence": 0.9, **bad}]}
    findings, errors = run3(pipe_input(), FakeProvider([answer]))
    assert by_rule(findings, CONTRA) == []
    assert complete_coverage(errors)


def test_invalid_items_dropped_but_valid_ones_kept():
    answer = {"findings": [
        {"line_ref": "#1"},  # missing fields
        {"line_ref": "#1", "property": "DN", "short_quote": "DN 150", "long_quote": "DN 200", "message": "m",
         "confidence": "high"},  # confidence not a number
        {"line_ref": "#1", "property": "DN", "short_quote": "DN 150", "long_quote": "DN 200", "message": "m",
         "confidence": 0.5},
    ]}
    findings, _ = run3(pipe_input(), FakeProvider([answer]))
    found = by_rule(findings, CONTRA)
    assert len(found) == 1 and found[0].evidence["confidence"] == 0.5


def test_value_also_in_long_text_is_downgraded_to_info():
    analysis_input = from_data({"lines": [
        line("a", "Rohr DN 150", "Rohr DN 150 mit Abzweig DN 100 herstellen."),
    ]})
    answer = {"findings": [{"line_ref": "#1", "property": "DN", "short_quote": "DN 150", "long_quote": "DN 100",
                            "message": "m", "confidence": 0.9}]}
    found = by_rule(run3(analysis_input, FakeProvider([answer]))[0], CONTRA)
    assert found[0].severity == "info"
    assert found[0].evidence["confidence"] <= 0.3


def test_layer1_text_errors_skip_the_line():
    from analysis.contracts import Finding, Target
    prior = [Finding(id="p", layer=1, rule_id="L1.X.Y", category="text", severity="error", scope="line",
                     target=Target(line_id=pipe_input().lines[0].id, field="long_text"), title="t", message="m")]
    provider = FakeProvider(lambda request: {"findings": []})
    run3(pipe_input(), provider, prior=prior)
    items = json.loads(sent(provider)[0].prompt.split("\n\n", 1)[1])["items"]
    assert "01.0010" not in [item["code"] for item in items]


def test_finding_id_is_stable_across_runs():
    first = by_rule(run3(pipe_input(), FakeProvider(contradiction_answer))[0], CONTRA)
    second = by_rule(run3(pipe_input(), FakeProvider(contradiction_answer))[0], CONTRA)
    assert first[0].id == second[0].id


# --------------------------------------------------------------------------- session: cache, budget, failures


def test_cache_answers_repeat_run_without_calling_the_model(tmp_path):
    cache_dir = tmp_path / "cache"
    first = FakeProvider(contradiction_answer)
    layer3.run(pipe_input(), [], [], provider=first, cache=ResponseCache(cache_dir))
    assert len(sent(first)) == 1 and list(cache_dir.glob("*.json"))

    second = FakeProvider([RuntimeError("must not be called")])
    errors = []
    findings = layer3.run(pipe_input(), [], errors, provider=second, cache=ResponseCache(cache_dir))
    assert second.requests == []
    assert complete_coverage(errors)
    assert len(by_rule(findings, CONTRA)) == 1


def test_call_budget_caps_requests_and_is_reported(monkeypatch):
    monkeypatch.setenv("ANALYSIS_L3_MAX_BATCH_LINES", "1")
    analysis_input = from_data({"lines": [line(f"0{i}", f"Rohr DN {i}00", f"Rohr DN {i}00 verlegen, SN 8.")
                                          for i in range(1, 6)]})
    provider = FakeProvider(lambda request: {"findings": []})
    errors = []
    layer3.run(analysis_input, [], errors, provider=provider, cache=ResponseCache(None), max_calls=2)
    assert len(provider.requests) == 2 and len(sent(provider)) == 2
    assert any(f"{CONTRA}: 3 batch(es) not checked (call budget of 2 reached)" in error for error in errors)


def test_request_failure_goes_to_errors_and_other_batches_still_run(monkeypatch):
    monkeypatch.setenv("ANALYSIS_L3_MAX_BATCH_LINES", "1")
    analysis_input = from_data({"lines": [
        line("a", "PVC-Rohr DN 150", "PVC-Rohr DN 200 verlegen."),
        line("b", "PVC-Rohr DN 150", "PVC-Rohr DN 200 verlegen."),
    ]})
    provider = FakeProvider([ProviderError("timed out"), contradiction_answer(
        LLMRequest("", "x\n\n" + json.dumps({"items": [{"ref": "#1", "short_text": "PVC-Rohr DN 150",
                                                      "long_text": "PVC-Rohr DN 200 verlegen."}]}), {},
                   CONTRADICTION_VERSION))])
    findings, errors = run3(analysis_input, provider)
    assert any("timed out" in error for error in errors)
    assert len(by_rule(findings, CONTRA)) == 1


def test_unavailable_provider_is_called_once_and_reported_once(monkeypatch):
    monkeypatch.setenv("ANALYSIS_L3_MAX_BATCH_LINES", "1")
    analysis_input = from_data({"lines": [line(c, "Rohr DN 150", "Rohr DN 200 verlegen.") for c in "abc"]})
    provider = FakeProvider(lambda request: ProviderUnavailable("connection refused"))
    findings, errors = run3(analysis_input, provider)
    assert len(provider.requests) == 1
    assert findings == []
    assert sum("unavailable" in error for error in errors) == 1


def test_runner_keeps_layer_1_and_2_findings_when_layer_3_fails(monkeypatch):
    unavailable = FakeProvider(lambda request: ProviderUnavailable("Ollama not reachable"))
    monkeypatch.setattr(layer3, "provider_from_env", lambda: unavailable)
    monkeypatch.setenv("ANALYSIS_L3_CACHE", "off")
    analysis_input = from_data({"lines": [
        line("a", "Rohr DN 150", "Rohr DN 200 verlegen.", quantity=None),  # L1.QTY.MISSING
    ]})
    result = analyze(analysis_input, [1, 2, 3])
    assert result.layers_run == [1, 2, 3]
    assert any(finding.layer == 1 for finding in result.findings)
    assert not any(finding.layer == 3 for finding in result.findings)
    assert any("unavailable: Ollama not reachable" in error for error in result.errors)


def test_repeated_timeouts_stop_calling_the_provider(monkeypatch):
    monkeypatch.setenv("ANALYSIS_L3_MAX_BATCH_LINES", "1")
    analysis_input = from_data({"lines": [line(c, "Rohr DN 150", "Rohr DN 200 verlegen.") for c in "abcdef"]})
    provider = FakeProvider(lambda request: ProviderError("timed out"))
    findings, errors = run3(analysis_input, provider)
    assert len(provider.requests) == 3 and len(sent(provider)) == 3
    assert any("unavailable: 3 requests failed in a row" in e and "batch(es) not checked" in e for e in errors)


def test_disabled_provider(monkeypatch):
    monkeypatch.setenv("ANALYSIS_L3_PROVIDER", "none")
    errors = []
    assert layer3.run(pipe_input(), [], errors) == []
    assert errors == ["layer 3: disabled (ANALYSIS_L3_PROVIDER=none)", "layer 3 coverage: 0/0 batches"]


def test_provider_from_env(monkeypatch):
    monkeypatch.setenv("ANALYSIS_L3_PROVIDER", "ollama")
    monkeypatch.setenv("ANALYSIS_L3_MODEL", "llama3.1:8b")
    provider = provider_from_env()
    assert isinstance(provider, OllamaProvider) and provider.model_id == "ollama/llama3.1:8b"
    monkeypatch.setenv("ANALYSIS_L3_PROVIDER", "nonsense")
    with pytest.raises(ProviderUnavailable):
        provider_from_env()


# --------------------------------------------------------------------------- layer 2 confirmation


def screed_input():
    return from_data({"lines": [
        line("01.0010", "Zementestrich CT-C25-F4, 50 mm",
             "Zementestrich auf Trennlage herstellen, einschließlich Randstreifen aus PE-Schaum 8 mm.",
             quantity="120", unit="m²"),
        line("01.0020", "Bodenbelag Linoleum 2,5 mm", "Linoleum vollflächig verkleben.", quantity="120",
             unit="m²"),
        line("01.0030", "Vorarbeiten Untergrund", "Vorbereitung des Untergrunds erfolgt bauseits durch den AG.",
             quantity="1", unit="psch"),
    ]})


def layer2_findings(analysis_input):
    from analysis import layer1, layer2
    l1 = layer1.run(analysis_input, [], [])
    return l1 + layer2.run(analysis_input, l1, [])


def answer_for(request, verdicts):
    """verdicts: requirement name -> (verdict, item code, quote)."""
    payload = json.loads(request.prompt.split("\n\n", 1)[1])
    refs = {item["code"]: item["ref"] for item in payload["items"]}
    reviews = []
    for finding in payload["findings"]:
        verdict, code, quote = verdicts.get(finding["requirement"], ("unclear", None, ""))
        reviews.append({"finding_ref": finding["ref"], "verdict": verdict, "line_ref": refs.get(code, ""),
                        "quote": quote, "reason": "Because.", "confidence": 0.8})
    return {"reviews": reviews}


def test_l2_confirm_included_excluded_missing():
    analysis_input = screed_input()
    prior = layer2_findings(analysis_input)
    reviewed = {f.evidence["dependency"]: f for f in prior if f.layer == 2 and f.evidence.get("reason") == "missing"}
    assert {"Edge insulation", "Primer and leveling", "Underlays and insulation", "Floor covering",
            "Skirting"} <= set(reviewed)
    verdicts = {
        "Edge insulation": ("included", "01.0010", "einschließlich Randstreifen aus PE-Schaum"),
        "Floor covering": ("included", "01.0020", "Linoleum vollflächig verkleben"),
        "Primer and leveling": ("excluded", "01.0030", "bauseits durch den AG"),
        "Underlays and insulation": ("missing", None, ""),
        # Skirting: unclear
    }
    provider = FakeProvider(lambda request: answer_for(request, verdicts)
                            if "findings" in request.prompt and "requirement" in request.prompt else {"findings": []})
    findings, errors = run3(analysis_input, provider, prior=prior)
    confirm = {f.evidence["reviews_finding_id"]: f for f in by_rule(findings, CONFIRM)}
    assert complete_coverage(errors)

    included = confirm[reviewed["Edge insulation"].id]
    assert included.severity == "info" and included.evidence["verdict"] == "included"
    assert included.evidence["quote_line_code"] == "01.0010"
    assert included.target.model_dump() == reviewed["Edge insulation"].target.model_dump()

    excluded = confirm[reviewed["Primer and leveling"].id]
    assert excluded.evidence["verdict"] == "excluded"
    assert analysis_input.lines[2].id in excluded.related_line_ids

    missing = [f for f in confirm.values() if f.evidence["verdict"] == "missing"]
    assert missing and all(f.severity == "warning" for f in missing)
    # the unclear verdict (skirting) produces nothing
    assert reviewed["Skirting"].id not in confirm
    assert len(confirm) == 4
    assert all(f.layer == 3 and f.origin == "llm" for f in confirm.values())


def test_l2_confirm_drops_unverified_quotes_and_unknown_refs():
    analysis_input = screed_input()
    prior = layer2_findings(analysis_input)

    def answer(request):
        if "requirement" not in request.prompt:
            return {"findings": []}
        payload = json.loads(request.prompt.split("\n\n", 1)[1])
        first = payload["findings"][0]["ref"]
        return {"reviews": [
            {"finding_ref": first, "verdict": "included", "line_ref": "#1", "quote": "inkl. Randdämmstreifen",
             "reason": "r", "confidence": 0.9},                    # quote not in the text
            {"finding_ref": "F99", "verdict": "missing", "line_ref": "", "quote": "", "reason": "r",
             "confidence": 0.9},                                   # unknown finding
            {"finding_ref": first, "verdict": "excluded", "line_ref": "#7", "quote": "bauseits", "reason": "r",
             "confidence": 0.9},                                   # unknown line
        ]}

    findings, _ = run3(analysis_input, FakeProvider(answer), prior=prior)
    assert by_rule(findings, CONFIRM) == []


def test_l2_confirm_sends_triggers_and_section_neighbours_only():
    analysis_input = from_data({
        "sections": [{"id": "s1", "code": "01", "title": "Estrich", "sort_order": 0},
                     {"id": "s2", "code": "02", "title": "Maler", "sort_order": 1}],
        "lines": [
            line("01.0010", "Zementestrich 50 mm", "Zementestrich herstellen.", "100", "m²", section_id="s1"),
            line("01.0020", "Randstreifen", "PE-Randstreifen 8 mm.", "40", "m", section_id="s1"),
            line("02.0010", "Wandanstrich", "Dispersionsfarbe, zweimal.", "300", "m²", section_id="s2"),
        ],
    })
    prior = layer2_findings(analysis_input)
    provider = FakeProvider(lambda request: {"findings": []} if "requirement" not in request.prompt
                            else {"reviews": []})
    run3(analysis_input, provider, prior=prior)
    confirm_requests = [r for r in provider.requests if "requirement" in r.prompt]
    assert confirm_requests
    codes = {item["code"] for r in confirm_requests
             for item in json.loads(r.prompt.split("\n\n", 1)[1])["items"]}
    assert "01.0020" in codes and "02.0010" not in codes


def test_no_l2_findings_means_no_l2_calls():
    provider = FakeProvider(lambda request: {"findings": []})
    run3(pipe_input(), provider, prior=[])
    assert all("requirement" not in r.prompt for r in provider.requests)


def test_eval_harness_runs_offline(monkeypatch):
    from analysis.layer3.eval import evaluate
    monkeypatch.setenv("ANALYSIS_L3_CACHE", "off")
    result = evaluate(FakeProvider(lambda request: {"findings": [], "reviews": []}))
    assert result["model"] == "fake" and all(e.startswith("layer 3 coverage: ") for e in result["errors"])
    assert result["contradiction"]["recall"] == 0
    assert all(row["got"] == "unclear" for row in result["l2_confirm"]["cases"])
