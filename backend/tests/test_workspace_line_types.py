import json

import pytest

import workspace_line_types
from analysis.layer3.provider import FakeProvider, ProviderError, ResponseCache


def test_classifies_and_caches_descriptions_independently_of_batch(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake")
    monkeypatch.setattr(workspace_line_types, "_cache", ResponseCache(None))
    fake = FakeProvider([{"lines": [{"index": 1, "type": "combined"}, {"index": 0, "type": "activity"}]}])

    def provider(model, **kwargs):
        assert model == "claude-haiku-5-5"
        return fake

    monkeypatch.setattr(workspace_line_types, "AnthropicProvider", provider)
    activity = {"short": "Rohr montieren", "long": "Rohr wird bauseits gestellt."}
    combined = {"short": "Rohr liefern und montieren"}
    assert workspace_line_types.classify({"lines": [activity, combined, activity, {}]}) == {
        "status": "ready", "types": ["activity", "combined", "activity", "unclassified"],
    }
    assert workspace_line_types.classify({"lines": [combined, activity]})["types"] == ["combined", "activity"]
    assert len(fake.requests) == 1
    assert json.loads(fake.requests[0].prompt) == [
        {"index": 0, **activity}, {"index": 1, **combined, "long": ""},
    ]


def test_disabled_without_credentials(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert workspace_line_types.classify({"lines": [{"short": "Pipe"}]}) == {"status": "disabled"}


def test_rejects_duplicate_response_indexes(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake")
    monkeypatch.setattr(workspace_line_types, "_cache", ResponseCache(None))
    fake = FakeProvider([
        {"lines": [{"index": 0, "type": "material"}, {"index": 0, "type": "combined"}]},
        {"lines": [{"index": 0, "type": "combined"}, {"index": 1, "type": "activity"}]},
    ])
    monkeypatch.setattr(workspace_line_types, "AnthropicProvider", lambda *args, **kwargs: fake)
    payload = {"lines": [{"short": "Pipe"}, {"short": "Inspection"}]}
    with pytest.raises(ProviderError):
        workspace_line_types.classify(payload)
    assert workspace_line_types.classify(payload)["types"] == ["combined", "activity"]
