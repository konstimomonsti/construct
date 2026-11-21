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
from .provider import LLMProvider, LLMRequest, ProviderError, ProviderUnavailable, ResponseCache

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
    consecutive_failures: int = 0
    unavailable: str | None = None
    skipped: Counter = field(default_factory=Counter)  # rule_id -> batches not sent
    dropped: Counter = field(default_factory=Counter)  # rule_id -> answer items that failed validation
    late: Counter = field(default_factory=Counter)  # rule_id -> batches not sent because time ran out
    memo: dict[str, Any] = field(default_factory=dict)  # results shared between the rules of one run

    @property
    def model_id(self) -> str:
        return self.provider.model_id

    def model_for(self, audit: bool = False) -> str:
        return self._provider(audit).model_id

    def _provider(self, audit: bool) -> LLMProvider:
        return self.audit_provider if audit and self.audit_provider is not None else self.provider

    def ask(self, rule_id: str, request: LLMRequest, *, audit: bool = False) -> dict[str, Any] | None:
        provider = self._provider(audit)
        key = request.cache_key(provider.model_id)
        cached = self.cache.get(key)
        if cached is not None:
            self.cache_hits += 1
            return cached
        if not self._reserve(rule_id):
            return None
        return self._settle(rule_id, provider, request, key, lambda: provider.complete_json(request))

    def ask_many(self, rule_id: str, requests: list[LLMRequest], *,
                 audit: bool = False) -> list[dict[str, Any] | None]:
        """Like `ask` for independent batches; answers come back in the order of `requests`."""
        if self.concurrency <= 1:
            return [self.ask(rule_id, request, audit=audit) for request in requests]
        provider = self._provider(audit)
        results: list[dict[str, Any] | None] = [None] * len(requests)
        pending: list[tuple[int, LLMRequest, str]] = []
        for index, request in enumerate(requests):
            key = request.cache_key(provider.model_id)
            cached = self.cache.get(key)
            if cached is not None:
                self.cache_hits += 1
                results[index] = cached
            elif self._reserve(rule_id):
                pending.append((index, request, key))
        if len(pending) <= 1:
            for index, request, key in pending:
                results[index] = self._settle(rule_id, provider, request, key,
                                              lambda request=request: provider.complete_json(request))
            return results
        with ThreadPoolExecutor(max_workers=min(self.concurrency, len(pending))) as pool:
            futures = [(index, request, key, pool.submit(provider.complete_json, request))
                       for index, request, key in pending]
            for index, request, key, future in futures:
                results[index] = self._settle(rule_id, provider, request, key, future.result)
        return results

    def _reserve(self, rule_id: str) -> bool:
        """Spend one call of the budget, or count the batch as not checked."""
        if self.unavailable or self.calls >= self.max_calls:
            self.skipped[rule_id] += 1
            return False
        if self.deadline and time.monotonic() - self.started >= self.deadline:
            self.late[rule_id] += 1
            return False
        self.calls += 1
        return True

    def _settle(self, rule_id: str, provider: LLMProvider, request: LLMRequest, key: str,
                call: Callable[[], dict[str, Any]]) -> dict[str, Any] | None:
        try:
            answer = call()
        except ProviderUnavailable as exc:
            self.unavailable = str(exc)
            self.skipped[rule_id] += 1
            return None
        except Exception as exc:  # ProviderError, or a provider bug: must not hide the other batches
            message = str(exc) if isinstance(exc, ProviderError) else f"{type(exc).__name__}: {exc}"
            self.errors.append(f"{rule_id}: {message}")
            self.consecutive_failures += 1
            if self.consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                # A model that times out on every batch would otherwise hold the run for minutes.
                self.unavailable = f"{self.consecutive_failures} requests failed in a row (last: {message})"
            return None
        self.consecutive_failures = 0
        self.cache.put(key, request, provider.model_id, answer)
        return answer

    def report(self) -> None:
        """Called once after the layer ran: say what was not checked, so a partial run is visible."""
        skipped = sum(self.skipped.values())
        if self.unavailable:
            line = f"layer 3: provider {self.provider.model_id} unavailable: {self.unavailable}"
            if skipped:
                line += f"; {skipped} batch(es) not checked"
            self.errors.append(line)
            return
        for rule_id, count in sorted(self.skipped.items()):
            self.errors.append(f"{rule_id}: {count} batch(es) not checked (call budget of {self.max_calls} reached)")
        for rule_id, count in sorted(self.late.items()):
            self.errors.append(f"{rule_id}: {count} batch(es) not checked (time budget of {self.deadline:g} s reached)")


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
