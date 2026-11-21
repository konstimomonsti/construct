"""The per-run session (provider, cache, call budget, error reporting) and helpers shared by the checks.

A check never calls the provider directly: it calls `current().ask(rule_id, request)`, which

- returns a cached answer without spending budget,
- stops calling once the run's call budget is spent (and reports how many batches were skipped),
- stops calling a provider that turned out to be unavailable (one error line, not one per batch),
- stops calling once the run's time budget (ANALYSIS_L3_DEADLINE seconds) is spent,
- turns a failed request into a line in `errors` and returns None, so the other batches still run.

`ask_many` sends independent batches of one rule concurrently (ANALYSIS_L3_CONCURRENCY threads); the
threads only run the provider call, all bookkeeping happens on the calling thread. `audit=True` uses the
audit provider (ANALYSIS_L3_AUDIT_MODEL) for whole-section audits.
"""

from __future__ import annotations

from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar
from dataclasses import dataclass, field
import os
import time
from typing import Any, Callable, Iterable, Iterator

from ..contracts import Finding, Line
from .provider import (AnthropicProvider, LLMProvider, LLMRequest, MAX_REQUEST_CHARS, OllamaProvider,
                       ProviderError, ProviderUnavailable, ResponseCache)

DEFAULT_MAX_CALLS = 12
DEFAULT_DEADLINE = 75.0  # seconds of model calls per run; with a 30 s request timeout the layer ends < ~90 s
DEFAULT_CONCURRENCY = 4
DEFAULT_MAX_BATCH_CHARS = 12_000
DEFAULT_MAX_BATCH_LINES = 12
MAX_TEXT_CHARS = 3_000  # per text in a prompt; quotes are still checked against the full text
MAX_CONSECUTIVE_FAILURES = 3


@dataclass
class Session:
    provider: LLMProvider
    cache: ResponseCache
    errors: list[str]
    max_calls: int = DEFAULT_MAX_CALLS
    max_batch_chars: int = DEFAULT_MAX_BATCH_CHARS
    max_batch_lines: int = DEFAULT_MAX_BATCH_LINES
    audit_provider: LLMProvider | None = None
    deadline: float = DEFAULT_DEADLINE  # seconds from `started`; 0 = no time budget
    concurrency: int = DEFAULT_CONCURRENCY
    started: float = field(default_factory=time.monotonic)
    calls: int = 0
    cache_hits: int = 0
    planned: int = 0
    main_consecutive_failures: int = 0
    audit_consecutive_failures: int = 0
    main_unavailable: str | None = None
    audit_unavailable: str | None = None
    skipped: Counter = field(default_factory=Counter)  # rule_id -> batches not sent
    dropped: Counter = field(default_factory=Counter)  # rule_id -> answer items that failed validation
    late: Counter = field(default_factory=Counter)  # rule_id -> batches not sent because time ran out
    memo: dict[str, Any] = field(default_factory=dict)  # results shared between the rules of one run
    attempted: int = 0
    validated: int = 0
    failed: int = 0
    rule_errors: bool = False
    reasons: list[str] = field(default_factory=list)

    @property
    def unavailable(self) -> str | None:
        if self.main_unavailable:
            return self.main_unavailable
        return self.audit_unavailable

    @unavailable.setter
    def unavailable(self, val: str | None) -> None:
        self.main_unavailable = val
        self.audit_unavailable = val

    @property
    def consecutive_failures(self) -> int:
        return max(self.main_consecutive_failures, self.audit_consecutive_failures)

    @consecutive_failures.setter
    def consecutive_failures(self, val: int) -> None:
        self.main_consecutive_failures = val
        self.audit_consecutive_failures = val

    def _state(self) -> str:
        if self.main_unavailable and (self.audit_unavailable or self.audit_provider is None):
            return "unavailable"
        if self.planned == 0 and not self.rule_errors:
            return "no-candidates"
        total_omitted = sum(self.skipped.values()) + sum(self.late.values())
        total_dropped = sum(self.dropped.values())
        if self.rule_errors or self.failed or total_omitted or total_dropped or self.main_unavailable or self.audit_unavailable:
            return "degraded"
        return "complete"

    def outcome(self) -> dict[str, Any]:
        return {
            "state": self._state(),
            "provider": self.provider.model_id,
            "audit_provider": self.audit_provider.model_id if self.audit_provider else self.provider.model_id,
            "planned": self.planned,
            "attempted": self.attempted,
            "validated": self.validated,
            "cached": self.cache_hits,
            "failed": self.failed,
            "skipped": sum(self.skipped.values()) + sum(self.late.values()),
            "dropped": sum(self.dropped.values()),
            "reasons": sorted(set(self.reasons)),
        }

    @property
    def model_id(self) -> str:
        return self.provider.model_id

    def model_for(self, audit: bool = False) -> str:
        return self._provider(audit).model_id

    def _provider(self, audit: bool) -> LLMProvider:
        return self.audit_provider if audit and self.audit_provider is not None else self.provider

    def _is_unavailable(self, audit: bool = False) -> bool:
        return bool(self.audit_unavailable if audit else self.main_unavailable)

    def _reserve(self, rule_id: str, audit: bool = False) -> bool:
        """Spend one call of the budget, or count the batch as not checked."""
        if self._is_unavailable(audit) or self.calls >= self.max_calls:
            self.skipped[rule_id] += 1
            return False
        if self.deadline and time.monotonic() - self.started >= self.deadline:
            self.late[rule_id] += 1
            return False
        self.calls += 1
        self.attempted += 1
        return True

    def ask(self, rule_id: str, request: LLMRequest, *, audit: bool = False) -> dict[str, Any] | None:
        return self.ask_many(rule_id, [request], audit=audit)[0]

    def ask_many(self, rule_id: str, requests: list[LLMRequest], *,
                 audit: bool = False) -> list[dict[str, Any] | None]:
        """Process at most one wave of requests concurrently and settle in input order."""
        self.planned += len(requests)
        provider = self._provider(audit)
        results: list[dict[str, Any] | None] = [None] * len(requests)
        pending = []
        for index, request in enumerate(requests):
            if len(request.prompt) + len(request.system) > MAX_REQUEST_CHARS:
                self.skipped[rule_id] += 1
                self.reasons.append(f"{rule_id}: request exceeded the input size limit")
                continue
            key = request.cache_key(provider.model_id)
            cached = self.cache.get(key, request=request, model_id=provider.model_id)
            if cached is None:
                pending.append((index, request, key))
            else:
                self.cache_hits += 1
                self.validated += 1
                results[index] = cached
        if not pending:
            return results

        concurrency = max(1, min(self.concurrency, len(pending)))
        pool = ThreadPoolExecutor(max_workers=concurrency)
        deadline_at = self.started + self.deadline if self.deadline else None

        def send(request):
            if deadline_at is None:
                return provider.complete_json(request)
            remaining = deadline_at - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            if isinstance(provider, (AnthropicProvider, OllamaProvider)):
                return provider.complete_json(request, timeout_budget=remaining)
            return provider.complete_json(request)

        try:
            for first in range(0, len(pending), concurrency):
                wave = [
                    (index, request, key, pool.submit(send, request))
                    for index, request, key in pending[first:first + concurrency]
                    if self._reserve(rule_id, audit=audit)
                ]
                for index, request, key, future in wave:
                    remaining = max(0, deadline_at - time.monotonic()) if deadline_at else None
                    results[index] = self._settle(
                        rule_id, provider, request, key,
                        lambda: future.result(timeout=remaining), audit=audit,
                    )
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
        return results

    def _settle(self, rule_id: str, provider: LLMProvider, request: LLMRequest, key: str,
                call: Callable[[], dict[str, Any]], audit: bool = False) -> dict[str, Any] | None:
        try:
            answer = call()
        except TimeoutError:
            self.failed += 1
            self.reasons.append(f"{rule_id}: response deadline reached")
            return None
        except ProviderUnavailable as exc:
            if audit:
                self.audit_unavailable = str(exc)
            else:
                self.main_unavailable = str(exc)
            self.failed += 1
            self.reasons.append(f"{rule_id}: provider unavailable: {exc}")
            return None
        except Exception as exc:  # ProviderError, or a provider bug: must not hide the other batches
            self.failed += 1
            message = str(exc) if isinstance(exc, ProviderError) else f"Unexpected provider failure ({type(exc).__name__})"
            self.errors.append(f"{rule_id}: {message}")
            self.reasons.append(f"{rule_id}: {message}")
            if audit:
                self.audit_consecutive_failures += 1
                if self.audit_consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                    self.audit_unavailable = f"{self.audit_consecutive_failures} requests failed in a row (last: {message})"
            else:
                self.main_consecutive_failures += 1
                if self.main_consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                    self.main_unavailable = f"{self.main_consecutive_failures} requests failed in a row (last: {message})"
            return None

        if audit:
            self.audit_consecutive_failures = 0
        else:
            self.main_consecutive_failures = 0

        if not isinstance(answer, dict):
            self.failed += 1
            self.reasons.append(f"{rule_id}: malformed response: expected JSON object")
            return None

        # Validate envelope keys before caching: never cache malformed envelopes
        has_valid_envelope = True
        for req_key in request.schema.get("required", []):
            if req_key not in answer or answer[req_key] is None:
                has_valid_envelope = False
                break
            if request.schema.get("properties", {}).get(req_key, {}).get("type") == "array":
                if not isinstance(answer[req_key], list):
                    has_valid_envelope = False
                    break

        if not has_valid_envelope:
            self.failed += 1
            self.reasons.append(f"{rule_id}: malformed envelope: missing or invalid required keys")
            return None

        self.cache.put(key, request, provider.model_id, answer)
        self.validated += 1
        return answer

    def report(self) -> None:
        """Called once after the layer ran: say what was not checked, so a partial run is visible."""
        skipped = sum(self.skipped.values())
        omitted = self.skipped + self.late
        checked = self.validated
        coverage = f"layer 3 coverage: {checked}/{self.planned} batches"
        for rule_id, count in sorted(self.dropped.items()):
            if count:
                detail = f"{rule_id}: {count} response item(s) rejected during validation"
                self.errors.append(detail)
                self.reasons.append(detail)
        if omitted:
            coverage += "; skipped: " + ", ".join(f"{rule_id}×{count}" for rule_id, count in sorted(omitted.items()))
        if self.main_unavailable or self.audit_unavailable:
            if self.main_unavailable:
                line = f"layer 3: provider {self.provider.model_id} unavailable: {self.main_unavailable}"
                if skipped:
                    line += f"; {skipped} batch(es) not checked"
                self.errors.append(line)
            if self.audit_unavailable and self.audit_provider and self.audit_provider.model_id != self.provider.model_id:
                line = f"layer 3: audit provider {self.audit_provider.model_id} unavailable: {self.audit_unavailable}"
                self.errors.append(line)
            self.errors.append(coverage)
            return
        for rule_id, count in sorted(self.skipped.items()):
            self.errors.append(f"{rule_id}: {count} batch(es) not checked (call budget of {self.max_calls} reached)")
        for rule_id, count in sorted(self.late.items()):
            self.errors.append(f"{rule_id}: {count} batch(es) not checked (time budget of {self.deadline:g} s reached)")
        self.errors.append(coverage)


_SESSION: ContextVar[Session | None] = ContextVar("layer3_session", default=None)


def current() -> Session:
    session = _SESSION.get()
    if session is None:
        raise RuntimeError("layer 3 rules run only through analysis.layer3.run()")
    return session


def session_scope(session: Session):
    return _SESSION.set(session)


def reset_session(token) -> None:
    _SESSION.reset(token)


def float_env(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, default))
    except ValueError:
        return default
    return value if value >= 0 and value == value else default


def int_env(name: str, default: int) -> int:
    try:
        return max(0, int(os.environ.get(name, default)))
    except ValueError:
        return default


# --------------------------------------------------------------------------- line helpers


def clip(text: str | None, limit: int = MAX_TEXT_CHARS) -> str | None:
    if text is None or len(text) <= limit:
        return text
    return text[:limit] + " [...]"


def line_label(line: Line) -> str:
    text = line.short_text or line.long_text or ""
    text = text if len(text) <= 60 else text[:57] + "..."
    return f"{line.code or '(no code)'} {text}".strip()


def l1_error_fields(prior_findings: Iterable[Finding]) -> dict[str, set[str]]:
    """line id -> fields that have a layer 1 error (values on those fields are not reliable)."""
    result: dict[str, set[str]] = {}
    for finding in prior_findings:
        if finding.layer == 1 and finding.severity == "error" and finding.target.line_id:
            result.setdefault(finding.target.line_id, set()).add(finding.target.field or "")
    return result


def batches(entries: list[tuple[Any, int]], max_chars: int, max_lines: int) -> Iterator[list[Any]]:
    """Group (item, size) pairs in order into batches under both limits. An oversized item goes alone."""
    batch: list[Any] = []
    size = 0
    for item, item_size in entries:
        if batch and (size + item_size > max_chars or len(batch) >= max_lines):
            yield batch
            batch, size = [], 0
        batch.append(item)
        size += item_size
    if batch:
        yield batch


def packed_sections(chunks: list[tuple[Any, list[Line]]], sizes: dict[str, int],
                    max_chars: int, max_lines: int) -> Iterator[list[tuple[Any, list[Line]]]]:
    """Pack pre-split section chunks without crossing either request limit."""
    group: list[tuple[Any, list[Line]]] = []
    chars = line_count = 0
    for section_id, lines in chunks:
        chunk_chars = sum(sizes[line.id] for line in lines)
        if group and (chars + chunk_chars > max_chars or line_count + len(lines) > max_lines):
            yield group
            group, chars, line_count = [], 0, 0
        group.append((section_id, lines))
        chars += chunk_chars
        line_count += len(lines)
    if group:
        yield group
