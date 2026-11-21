"""LLM providers for layer 3: one small interface, a local and an API implementation, a fake for tests.

    provider.complete_json(LLMRequest) -> dict      # JSON that matches request.schema

Tender documents can be confidential, so the default is a local model (Ollama). The Anthropic API is
opt-in. Configuration comes from environment variables (see `provider_from_env`):

    ANALYSIS_L3_PROVIDER   ollama (default) | anthropic | none
    ANALYSIS_L3_MODEL      model id; default qwen2.5:7b-instruct (ollama) or claude-haiku-5-5 (anthropic)
    ANALYSIS_L3_AUDIT_MODEL model for whole-section audits; default claude-sonnet-5-5 (anthropic),
                           the ANALYSIS_L3_MODEL provider itself for ollama unless set
    ANALYSIS_L3_TIMEOUT    seconds per request (default 120)
    OLLAMA_HOST            default http://localhost:11434
    ANTHROPIC_API_KEY      or any other credential the anthropic SDK resolves

Answers are cached on disk by (model, prompt version, system prompt, prompt, schema), so re-analysing the
same input costs nothing (`ResponseCache`).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from hashlib import sha256
import json
import math
import os
from pathlib import Path
from typing import Any, Callable, Protocol
import urllib.error
import urllib.request

DEFAULT_OLLAMA_MODEL = "qwen2.5:7b-instruct"
DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5"
DEFAULT_ANTHROPIC_AUDIT_MODEL = "claude-sonnet-5-5"
DEFAULT_TIMEOUT = 120.0
DEFAULT_CACHE_DIR = Path(__file__).resolve().parents[2] / ".cache" / "layer3"


class ProviderError(Exception):
    """One request failed (timeout, bad JSON, refusal). Other requests may still work."""


class ProviderUnavailable(ProviderError):
    """The provider can't be used at all (not running, no credentials, unknown model). Stop calling it."""


@dataclass(frozen=True)
class LLMRequest:
    system: str
    prompt: str
    schema: dict[str, Any]
    prompt_version: str

    def cache_key(self, model_id: str) -> str:
        payload = {"model": model_id, "prompt_version": self.prompt_version, "system": self.system,
                   "prompt": self.prompt, "schema": self.schema}
        canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        return sha256(canonical.encode("utf-8")).hexdigest()


@dataclass
class ResponseDetails:
    raw: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class LLMProvider(Protocol):
    model_id: str

    def complete_json(self, request: LLMRequest) -> dict[str, Any]: ...


# --------------------------------------------------------------------------- local: Ollama


class OllamaProvider:
    """Local model through Ollama's /api/chat with a JSON-schema `format` and temperature 0."""

    def __init__(self, model: str = DEFAULT_OLLAMA_MODEL, host: str | None = None,
                 timeout: float = DEFAULT_TIMEOUT):
        self.model = model
        self.model_id = f"ollama/{model}"
        self.host = (host or os.environ.get("OLLAMA_HOST") or "http://localhost:11434").rstrip("/")
        if "://" not in self.host:
            self.host = "http://" + self.host
        self.timeout = timeout

    def complete_json(self, request: LLMRequest, details: ResponseDetails | None = None) -> dict[str, Any]:
        body = {
            "model": self.model, "stream": False, "format": request.schema,
            "options": {"temperature": 0, "seed": 0},
            "messages": [{"role": "system", "content": request.system},
                         {"role": "user", "content": request.prompt}],
        }
        http_request = urllib.request.Request(
            f"{self.host}/api/chat", data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"}, method="POST",
        )
        try:
            with urllib.request.urlopen(http_request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8", "replace")
                if details is not None:
                    details.raw = raw
                    if request_id := response.headers.get("X-Request-ID"):
                        details.metadata["request_id"] = request_id
                payload = json.loads(raw)
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            if details is not None:
                details.raw = raw
                details.metadata.update(http_status=exc.code, request_id=exc.headers.get("X-Request-ID"))
            detail = raw[:300]
            if exc.code == 404:
                raise ProviderUnavailable(f"Ollama model {self.model!r} not found ({detail}); "
                                          f"run `ollama pull {self.model}`") from exc
            raise ProviderError(f"Ollama HTTP {exc.code}: {detail}") from exc
        except TimeoutError as exc:
            raise ProviderError(f"Ollama timed out after {self.timeout:.0f}s") from exc
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, TimeoutError):
                raise ProviderError(f"Ollama timed out after {self.timeout:.0f}s") from exc
            raise ProviderUnavailable(f"Ollama not reachable at {self.host}: {exc.reason}") from exc
        except json.JSONDecodeError as exc:
            raise ProviderError(f"Ollama returned invalid JSON: {exc}") from exc
        message = payload.get("message") if isinstance(payload, dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if details is not None:
            if isinstance(content, str):
                details.raw = content
            if isinstance(payload, dict):
                details.metadata.update({key: payload[key] for key in ("prompt_eval_count", "eval_count", "done_reason")
                                         if key in payload})
        return _parse_json_object(content, "Ollama")


# --------------------------------------------------------------------------- API: Anthropic


class AnthropicProvider:
    """Claude through the official SDK, with structured output (`output_config.format`).

    Claude Haiku 5.5 and Sonnet 5.5 reject non-default sampling parameters, so determinism comes from
    the response cache, not from `temperature`. Effort is `low`: the checks are short classifications.
    The system prompt carries a `cache_control` breakpoint, so batches that share it pay ~0.1x for it.
    `usage` adds up the tokens of every answer (for cost reports).
    """

    def __init__(self, model: str = DEFAULT_ANTHROPIC_MODEL, timeout: float = DEFAULT_TIMEOUT,
                 max_tokens: int = 16000, effort: str = "low"):
        try:
            import anthropic
        except ImportError as exc:
            raise ProviderUnavailable("the anthropic package is not installed; "
                                      "pip install 'construct-analysis[llm-api]'") from exc
        self._anthropic = anthropic
        self.model = model
        self.model_id = model
        self.timeout = timeout
        self.max_tokens = max_tokens
        self.effort = effort
        self.usage: dict[str, int] = {}
        try:
            self._client = anthropic.Anthropic(timeout=timeout, max_retries=2)
        except Exception as exc:  # e.g. no credentials could be resolved
            raise ProviderUnavailable(f"Anthropic client could not be created: {exc}") from exc

    def complete_json(self, request: LLMRequest, details: ResponseDetails | None = None) -> dict[str, Any]:
        anthropic = self._anthropic
        client = self._client.with_options(max_retries=0) if details is not None else self._client
        try:
            response = client.messages.create(
                model=self.model, max_tokens=self.max_tokens,
                system=[{"type": "text", "text": request.system, "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": request.prompt}],
                output_config={"effort": self.effort,
                               "format": {"type": "json_schema", "schema": request.schema}},
            )
        except anthropic.APITimeoutError as exc:
            raise ProviderError("Anthropic request timed out") from exc
        except anthropic.APIConnectionError as exc:
            raise ProviderUnavailable(f"Anthropic API not reachable: {exc}") from exc
        except anthropic.APIStatusError as exc:
            if details is not None:
                details.raw = exc.response.text
                details.metadata.update(http_status=exc.status_code, request_id=getattr(exc, "request_id", None))
            if isinstance(exc, (anthropic.AuthenticationError, anthropic.PermissionDeniedError, anthropic.NotFoundError)):
                raise ProviderUnavailable(f"Anthropic API rejected the request: {exc.message}") from exc
            if isinstance(exc, anthropic.RateLimitError):
                raise ProviderError("Anthropic rate limit reached") from exc
            raise ProviderError(f"Anthropic HTTP {exc.status_code}: {exc.message}") from exc
        except anthropic.AnthropicError as exc:  # e.g. no credentials at request time
            raise ProviderUnavailable(f"Anthropic client error: {exc}") from exc
        text = next((block.text for block in response.content if block.type == "text"), None)
        for key in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"):
            self.usage[key] = self.usage.get(key, 0) + (getattr(response.usage, key, None) or 0)
        self.usage["requests"] = self.usage.get("requests", 0) + 1
        if details is not None:
            details.raw = text
            details.metadata = {"response_id": response.id, "request_id": getattr(response, "_request_id", None),
                                "usage": response.usage.model_dump(mode="json"), "stop_reason": response.stop_reason}
        if response.stop_reason == "refusal":
            raise ProviderError("Anthropic declined the request (stop_reason=refusal)")
        if response.stop_reason == "max_tokens":
            raise ProviderError(f"Anthropic answer truncated at max_tokens={self.max_tokens}")
        return _parse_json_object(text, "Anthropic")


# --------------------------------------------------------------------------- tests


@dataclass
class FakeProvider:
    """Returns canned JSON. `responses` is a callable (request -> dict) or a list consumed in order.

    A response that is an Exception instance is raised instead, to test failure handling.
    """

    responses: Callable[[LLMRequest], Any] | list[Any] = field(default_factory=list)
    model_id: str = "fake"
    requests: list[LLMRequest] = field(default_factory=list)

    def complete_json(self, request: LLMRequest) -> dict[str, Any]:
        self.requests.append(request)
        if callable(self.responses):
            answer = self.responses(request)
        elif self.responses:
            answer = self.responses.pop(0)
        else:
            answer = {}
        if isinstance(answer, Exception):
            raise answer
        if isinstance(answer, str):
            return _parse_json_object(answer, "Fake")
        return answer


# --------------------------------------------------------------------------- cache and configuration


class ResponseCache:
    """Answers on disk, one JSON file per request key. `None` directory = in-memory only."""

    def __init__(self, directory: Path | str | None):
        self.directory = Path(directory) if directory else None
        self._memory: dict[str, dict[str, Any]] = {}

    def get(self, key: str) -> dict[str, Any] | None:
        if key in self._memory:
            return self._memory[key]
        if self.directory is None:
            return None
        path = self.directory / f"{key}.json"
        try:
            entry = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        response = entry.get("response")
        if isinstance(response, dict):
            self._memory[key] = response
            return response
        return None

    def put(self, key: str, request: LLMRequest, model_id: str, response: dict[str, Any]) -> None:
        self._memory[key] = response
        if self.directory is None:
            return
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            tmp = self.directory / f"{key}.json.tmp"
            entry = {"model": model_id, "prompt_version": request.prompt_version, "response": response}
            tmp.write_text(json.dumps(entry, ensure_ascii=False, indent=1), encoding="utf-8")
            tmp.replace(self.directory / f"{key}.json")
        except OSError:
            pass  # a cache that can't be written only costs tokens


def cache_from_env() -> ResponseCache:
    setting = os.environ.get("ANALYSIS_L3_CACHE", "").strip()
    if setting.lower() in ("off", "none", "0", "false"):
        return ResponseCache(None)
    return ResponseCache(setting or DEFAULT_CACHE_DIR)


def provider_from_env() -> LLMProvider | None:
    """Build the configured provider. `None` means layer 3 is switched off."""
    name = os.environ.get("ANALYSIS_L3_PROVIDER", "ollama").strip().lower()
    model = os.environ.get("ANALYSIS_L3_MODEL", "").strip() or None
    try:
        timeout = float(os.environ.get("ANALYSIS_L3_TIMEOUT", DEFAULT_TIMEOUT))
    except ValueError:
        timeout = DEFAULT_TIMEOUT
    if not math.isfinite(timeout) or timeout <= 0:
        timeout = DEFAULT_TIMEOUT
    if name in ("", "none", "off", "disabled"):
        return None
    if name in ("ollama", "local"):
        return OllamaProvider(model or DEFAULT_OLLAMA_MODEL, timeout=timeout)
    if name in ("anthropic", "claude", "api"):
        return AnthropicProvider(model or DEFAULT_ANTHROPIC_MODEL, timeout=timeout)
    raise ProviderUnavailable(f"unknown ANALYSIS_L3_PROVIDER {name!r} (use ollama, anthropic or none)")


def audit_provider_from_env(main: LLMProvider) -> LLMProvider:
    """The provider for whole-section audits (ANALYSIS_L3_AUDIT_MODEL). Falls back to `main`."""
    model = os.environ.get("ANALYSIS_L3_AUDIT_MODEL", "").strip() or None
    if isinstance(main, AnthropicProvider):
        model = model or DEFAULT_ANTHROPIC_AUDIT_MODEL
        return main if model == main.model else AnthropicProvider(model, timeout=main.timeout)
    if isinstance(main, OllamaProvider) and model and model != main.model:
        return OllamaProvider(model, host=main.host, timeout=main.timeout)
    return main


def _parse_json_object(text: str | None, source: str) -> dict[str, Any]:
    if not isinstance(text, str) or not text:
        raise ProviderError(f"{source} returned an empty answer")
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ProviderError(f"{source} returned invalid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise ProviderError(f"{source} returned JSON that is not an object")
    return value
