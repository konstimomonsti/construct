"""Mocked Ollama/Anthropic request and response contracts and Layer 3 hardenings."""

import io
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request
from unittest.mock import MagicMock, patch

import pytest

from analysis.contracts import AnalysisInput, Line, Section
from analysis.layer3 import get_last_outcome, run as run_layer3
from analysis.layer3.common import Session
from analysis.layer3.provider import (
    AnthropicProvider,
    DEFAULT_ANTHROPIC_AUDIT_MODEL,
    DEFAULT_ANTHROPIC_MODEL,
    DEFAULT_OLLAMA_MODEL,
    FakeProvider,
    LLMRequest,
    MAX_REQUEST_CHARS,
    OllamaProvider,
    ProviderError,
    ProviderUnavailable,
    ResponseCache,
    audit_provider_from_env,
    cache_from_env,
    provider_from_env,
)
from analysis.layer3.schema import CONTRADICTION_SCHEMA, ContradictionItem, items
from analysis.runner import analyze


class MockResponse:
    def __init__(self, data: dict):
        self.raw = json.dumps(data).encode("utf-8")
        self.headers = {}

    def read(self):
        return self.raw

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


# 1. Model routing
def test_model_routing_env():
    with patch.dict(os.environ, {"ANALYSIS_L3_PROVIDER": "ollama", "ANALYSIS_L3_MODEL": "llama3:8b"}, clear=False):
        prov = provider_from_env()
        assert isinstance(prov, OllamaProvider)
        assert prov.model == "llama3:8b"
        assert prov.model_id == "ollama/llama3:8b"

    with patch.dict(os.environ, {"ANALYSIS_L3_PROVIDER": "anthropic", "ANALYSIS_L3_MODEL": "claude-haiku-test", "ANALYSIS_L3_AUDIT_MODEL": "claude-sonnet-test", "ANTHROPIC_API_KEY": "dummy_key"}, clear=False):
        prov = provider_from_env()
        assert isinstance(prov, AnthropicProvider)
        assert prov.model == "claude-haiku-test"
        audit_prov = audit_provider_from_env(prov)
        assert isinstance(audit_prov, AnthropicProvider)
        assert audit_prov.model == "claude-sonnet-test"

    with patch.dict(os.environ, {"ANALYSIS_L3_PROVIDER": "none"}, clear=False):
        assert provider_from_env() is None

    with patch.dict(os.environ, {"ANALYSIS_L3_PROVIDER": "unsupported"}, clear=False):
        with pytest.raises(ProviderUnavailable):
            provider_from_env()


# 2. Anthropic auth and rate limit
def test_anthropic_auth_and_rate_limit():
    import anthropic

    req = LLMRequest("sys", "prompt", CONTRADICTION_SCHEMA, "v1")
    mock_client = MagicMock()

    # AuthenticationError -> ProviderUnavailable
    mock_client.messages.create.side_effect = anthropic.AuthenticationError(
        message="Invalid API Key", response=MagicMock(status_code=401, text="Invalid API Key"), body=None
    )
    provider = AnthropicProvider(model="claude-haiku-5-5", client=mock_client)
    with pytest.raises(ProviderUnavailable) as exc:
        provider.complete_json(req)
    assert "rejected the request" in str(exc.value)

    # RateLimitError -> ProviderError
    mock_client.messages.create.side_effect = anthropic.RateLimitError(
        message="Rate limit exceeded", response=MagicMock(status_code=429, text="Rate limit exceeded"), body=None
    )
    with pytest.raises(ProviderError) as exc:
        provider.complete_json(req)
    assert "rate limit reached" in str(exc.value)


# 3. Anthropic refusal and truncation
def test_anthropic_refusal_and_truncation():
    req = LLMRequest("sys", "prompt", CONTRADICTION_SCHEMA, "v1")
    mock_client = MagicMock()

    # Refusal
    block = MagicMock()
    block.type = "text"
    block.text = "{}"
    mock_usage = MagicMock()
    mock_usage.input_tokens = 10
    mock_usage.output_tokens = 5
    mock_usage.cache_creation_input_tokens = 0
    mock_usage.cache_read_input_tokens = 0
    mock_response = MagicMock(content=[block], usage=mock_usage, stop_reason="refusal", id="msg_123", _request_id="req_123")
    mock_client.messages.create.side_effect = None
    mock_client.messages.create.return_value = mock_response

    provider = AnthropicProvider(model="claude-haiku-5-5", client=mock_client)
    with pytest.raises(ProviderError) as exc:
        provider.complete_json(req)
    assert "declined the request (stop_reason=refusal)" in str(exc.value)

    # Truncation
    mock_response.stop_reason = "max_tokens"
    with pytest.raises(ProviderError) as exc:
        provider.complete_json(req)
    assert "truncated at max_tokens" in str(exc.value)


# 4. Ollama mock contracts
def test_ollama_mock_contracts():
    req = LLMRequest("sys", "prompt", CONTRADICTION_SCHEMA, "v1")

    # 401 Auth error -> ProviderUnavailable
    def mock_opener_401(http_req, timeout=None):
        raise urllib.error.HTTPError(http_req.full_url, 401, "Unauthorized", {}, io.BytesIO(b"Unauthorized"))

    prov = OllamaProvider(opener=mock_opener_401)
    with pytest.raises(ProviderUnavailable) as exc:
        prov.complete_json(req)
    assert "authentication failed" in str(exc.value)

    # 429 Rate limit -> ProviderError
    def mock_opener_429(http_req, timeout=None):
        raise urllib.error.HTTPError(http_req.full_url, 429, "Too Many Requests", {}, io.BytesIO(b"Rate limit"))

    prov = OllamaProvider(opener=mock_opener_429)
    with pytest.raises(ProviderError) as exc:
        prov.complete_json(req)
    assert "rate limit reached" in str(exc.value)

    # 413 Payload too large -> ProviderError
    def mock_opener_413(http_req, timeout=None):
        raise urllib.error.HTTPError(http_req.full_url, 413, "Payload Too Large", {}, io.BytesIO(b"Payload too large"))

    prov = OllamaProvider(opener=mock_opener_413)
    with pytest.raises(ProviderError) as exc:
        prov.complete_json(req)
    assert "payload too large" in str(exc.value)

    # Refusal & Truncation
    def mock_opener_refusal(http_req, timeout=None):
        return MockResponse({"message": {"content": "{}"}, "done_reason": "refusal"})

    prov = OllamaProvider(opener=mock_opener_refusal)
    with pytest.raises(ProviderError) as exc:
        prov.complete_json(req)
    assert "declined the request (done_reason=refusal)" in str(exc.value)

    def mock_opener_length(http_req, timeout=None):
        return MockResponse({"message": {"content": "{}"}, "done_reason": "length"})

    prov = OllamaProvider(opener=mock_opener_length)
    with pytest.raises(ProviderError) as exc:
        prov.complete_json(req)
    assert "answer truncated (done_reason=length)" in str(exc.value)


# 5. Malformed responses are not cached
def test_malformed_responses_not_cached():
    cache = ResponseCache(None)
    fake = FakeProvider(responses=[
        {},  # missing 'findings'
        {"findings": None},  # null 'findings'
        {"findings": []},  # valid empty array
    ])
    session = Session(provider=fake, cache=cache, errors=[])
    req = LLMRequest("sys", "prompt", CONTRADICTION_SCHEMA, "v1")

    # 1. First call returns {} -> not cached
    ans1 = session.ask("L3.TEST", req)
    assert ans1 is None
    assert cache.get(req.cache_key(fake.model_id), request=req, model_id=fake.model_id) is None
    assert any("malformed envelope" in r for r in session.reasons)

    # 2. Second call returns {"findings": None} -> not cached
    ans2 = session.ask("L3.TEST", req)
    assert ans2 is None
    assert cache.get(req.cache_key(fake.model_id), request=req, model_id=fake.model_id) is None

    # 3. Third call returns {"findings": []} -> valid, gets cached!
    ans3 = session.ask("L3.TEST", req)
    assert ans3 == {"findings": []}
    assert cache.get(req.cache_key(fake.model_id), request=req, model_id=fake.model_id) == {"findings": []}


# 6. Cache revalidation and stale cache eviction
def test_cache_revalidation_and_stale_cache(tmp_path):
    cache = ResponseCache(tmp_path)
    req = LLMRequest("sys", "prompt", CONTRADICTION_SCHEMA, "v1")
    key = req.cache_key("test_model")

    # Put valid response
    cache.put(key, req, "test_model", {"findings": []})
    assert cache.get(key, request=req, model_id="test_model") == {"findings": []}

    # Model mismatch
    assert cache.get(key, request=req, model_id="other_model") is None

    # Prompt version mismatch
    req_v2 = LLMRequest("sys", "prompt", CONTRADICTION_SCHEMA, "v2")
    assert cache.get(key, request=req_v2, model_id="test_model") is None

    # Corrupt on-disk file (invalid JSON)
    cache_file = tmp_path / f"{key}.json"
    cache._memory.clear()
    cache_file.write_text("{corrupt json", encoding="utf-8")
    assert cache.get(key, request=req, model_id="test_model") is None

    # Corrupt on-disk envelope (missing required findings)
    cache_file.write_text(json.dumps({"model": "test_model", "prompt_version": "v1", "response": {}}), encoding="utf-8")
    assert cache.get(key, request=req, model_id="test_model") is None


# 7. Confidentiality policy
def test_confidentiality_policy(tmp_path):
    with patch.dict(os.environ, {"ANALYSIS_L3_CONFIDENTIAL": "1"}, clear=False):
        cache = ResponseCache(tmp_path)
        req = LLMRequest("sys", "prompt", CONTRADICTION_SCHEMA, "v1")
        key = req.cache_key("test_model")
        cache.put(key, req, "test_model", {"findings": []})

        # Memory has it, but disk file was NOT created due to confidentiality policy
        assert cache._memory.get(key) is not None
        assert not (tmp_path / f"{key}.json").exists()

        env_cache = cache_from_env()
        assert env_cache.directory is None


# 8. Oversized inputs
def test_oversized_inputs():
    big_prompt = "x" * (MAX_REQUEST_CHARS + 10)
    req = LLMRequest("sys", big_prompt, CONTRADICTION_SCHEMA, "v1")

    ollama = OllamaProvider()
    with pytest.raises(ProviderError) as exc:
        ollama.complete_json(req)
    assert "exceeds maximum allowed" in str(exc.value)

    anthropic_p = AnthropicProvider(client=MagicMock())
    with pytest.raises(ProviderError) as exc:
        anthropic_p.complete_json(req)
    assert "exceeds maximum allowed" in str(exc.value)


# 9. Deadline enforcement
def test_deadline_enforcement():
    def slow_call(req):
        time.sleep(0.02)
        return {"findings": []}

    fake = FakeProvider(slow_call)
    session = Session(provider=fake, cache=ResponseCache(None), errors=[], deadline=0.03, concurrency=1)
    reqs = [LLMRequest("sys", f"prompt_{i}", CONTRADICTION_SCHEMA, "v1") for i in range(5)]

    results = session.ask_many("L3.TEST", reqs)
    # The first task runs (~0.02s), subsequent exceed deadline
    assert session.late["L3.TEST"] >= 1
    assert session.outcome()["state"] == "degraded"


# 10. Role failure isolation
def test_role_failure_isolation():
    main_provider = FakeProvider(responses=[{"findings": []}])
    audit_provider = FakeProvider(responses=ProviderUnavailable("Audit model service down"))

    session = Session(provider=main_provider, audit_provider=audit_provider, cache=ResponseCache(None), errors=[])
    req = LLMRequest("sys", "prompt", CONTRADICTION_SCHEMA, "v1")

    # Audit call fails and marks audit_unavailable
    res_audit = session.ask("L3.AUDIT", req, audit=True)
    assert res_audit is None
    assert session.audit_unavailable is not None
    assert session.main_unavailable is None

    # Main provider is isolated: it continues to work!
    res_main = session.ask("L3.MAIN", req, audit=False)
    assert res_main == {"findings": []}
    assert session.main_unavailable is None


# 11. Preserving deterministic results on provider failure
def test_provider_failure_preserves_deterministic_results():
    inp = AnalysisInput(
        sections=[Section(id="s1", parent_id=None, sort_order=0)],
        lines=[
            # Line with L1 unit mismatch error
            Line(id="l1", code="01.01.0010", short_text="Rohr DN 100", long_text="Rohr DN 100 Abrechnung nach m", unit="ea", quantity=10, sort_order=0),
        ],
    )
    with patch.dict(os.environ, {"ANALYSIS_L3_PROVIDER": "unsupported_fail"}, clear=False):
        res = analyze(inp, layers=[1, 2, 3])
        # L1/L2 findings are 100% preserved
        assert len(res.findings) >= 1
        assert res.l3_status["state"] == "unavailable"
