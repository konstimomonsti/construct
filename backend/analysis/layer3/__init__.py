"""Layer 3: LLM checks for what code and regex can't express. See docs/ANALYSIS_LAYERS.md §5.

Every result is a proposal for a person to review: findings are `warning` or `info`, `origin="llm"`,
and carry the model id and prompt version. Failures (no model, timeout, bad JSON) go to `errors`;
layers 1 and 2 keep their findings.

    python -m analysis run data/tenders/file.X83 --layers 1,2,3

Configuration: environment variables, see `analysis/layer3/provider.py` and `common.py`
(ANALYSIS_L3_PROVIDER, ANALYSIS_L3_MODEL, ANALYSIS_L3_AUDIT_MODEL, ANALYSIS_L3_MAX_CALLS,
ANALYSIS_L3_DEADLINE, ANALYSIS_L3_CACHE, ...).
"""

from __future__ import annotations

from ..contracts import AnalysisInput, Finding
from ..registry import run_layer
from . import checks  # noqa: F401  (registers the rules)
from .common import (
    DEFAULT_CONCURRENCY, DEFAULT_DEADLINE, DEFAULT_MAX_BATCH_CHARS, DEFAULT_MAX_BATCH_LINES, DEFAULT_MAX_CALLS,
    Session, float_env, int_env, reset_session, session_scope,
)
from .provider import (
    LLMProvider, ProviderUnavailable, ResponseCache, audit_provider_from_env, cache_from_env, provider_from_env,
)

LAYER = 3

_LAST_OUTCOME: dict | None = None


def get_last_outcome() -> dict | None:
    return _LAST_OUTCOME


def run(analysis_input: AnalysisInput, prior_findings: list[Finding], errors: list[str] | None = None, *,
        provider: LLMProvider | None = None, cache: ResponseCache | None = None,
        max_calls: int | None = None, audit_provider: LLMProvider | None = None) -> list[Finding]:
    """Run the layer 3 rules. Without `provider`, both providers are built from the environment.

    With an explicit `provider` and no `audit_provider`, audits use `provider` too (tests, eval).
    """
    global _LAST_OUTCOME
    errors = errors if errors is not None else []
    if provider is None:
        try:
            provider = provider_from_env()
        except ProviderUnavailable as exc:
            errors.append(f"layer 3: {exc}")
            errors.append("layer 3 coverage: 0/0 batches")
            _LAST_OUTCOME = {
                "state": "unavailable",
                "provider": None,
                "audit_provider": None,
                "planned": 0,
                "attempted": 0,
                "validated": 0,
                "cached": 0,
                "failed": 0,
                "skipped": 0,
                "dropped": 0,
                "reasons": [str(exc)],
            }
            return []
        if provider is None:
            errors.append("layer 3: disabled (ANALYSIS_L3_PROVIDER=none)")
            errors.append("layer 3 coverage: 0/0 batches")
            _LAST_OUTCOME = {
                "state": "disabled",
                "provider": None,
                "audit_provider": None,
                "planned": 0,
                "attempted": 0,
                "validated": 0,
                "cached": 0,
                "failed": 0,
                "skipped": 0,
                "dropped": 0,
                "reasons": ["Layer 3 disabled (ANALYSIS_L3_PROVIDER=none)"],
            }
            return []
        if audit_provider is None:
            try:
                audit_provider = audit_provider_from_env(provider)
            except ProviderUnavailable as exc:
                errors.append(f"layer 3 audit model: {exc}")
                audit_provider = provider
    session = Session(
        provider=provider, cache=cache if cache is not None else cache_from_env(), errors=errors,
        max_calls=max_calls if max_calls is not None else int_env("ANALYSIS_L3_MAX_CALLS", DEFAULT_MAX_CALLS),
        max_batch_chars=int_env("ANALYSIS_L3_MAX_BATCH_CHARS", DEFAULT_MAX_BATCH_CHARS),
        max_batch_lines=max(1, int_env("ANALYSIS_L3_MAX_BATCH_LINES", DEFAULT_MAX_BATCH_LINES)),
        audit_provider=audit_provider, deadline=float_env("ANALYSIS_L3_DEADLINE", DEFAULT_DEADLINE),
        concurrency=max(1, int_env("ANALYSIS_L3_CONCURRENCY", DEFAULT_CONCURRENCY)),
    )
    token = session_scope(session)
    try:
        findings = run_layer(LAYER, analysis_input, prior_findings, errors)
    finally:
        reset_session(token)
        session.report()
        _LAST_OUTCOME = session.outcome()
    return findings
