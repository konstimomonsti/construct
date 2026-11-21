"""Live layer 3 run on the LV_11 fixture through the Anthropic API. Skipped without ANTHROPIC_API_KEY.

    $env:ANTHROPIC_API_KEY="..."; $env:PYTHONPATH="backend;backend/importer"
    python -m pytest -q -s -m integration backend/analysis/tests/test_layer3_live.py

Prints the duration, tokens and an estimated cost of the run (no response cache, so every call is paid).
"""

import os
from pathlib import Path
import time

import pytest

from analysis import layer3
from analysis.contracts import AnalysisInput
from analysis.layer3.provider import DEFAULT_ANTHROPIC_AUDIT_MODEL, DEFAULT_ANTHROPIC_MODEL, ResponseCache
from analysis.runner import analyze

pytestmark = [pytest.mark.integration,
              pytest.mark.skipif(not os.environ.get("ANTHROPIC_API_KEY"), reason="needs ANTHROPIC_API_KEY")]

FIXTURE = Path(__file__).parent / "fixtures" / "lv11_precast.json"
# USD per million tokens: input, output. Cache writes cost 1.25x input, cache reads 0.1x (Haiku) / 0.05x (Sonnet).
PRICES = {"claude-haiku-5-5": (0.10, 0.50, 0.10), "claude-sonnet-5-5": (2.00, 10.00, 0.05)}


def cost(model: str, usage: dict[str, int]) -> float:
    price_in, price_out, read = PRICES.get(model, (0.0, 0.0, 0.0))
    return (usage.get("input_tokens", 0) * price_in + usage.get("output_tokens", 0) * price_out
            + usage.get("cache_creation_input_tokens", 0) * price_in * 1.25
            + usage.get("cache_read_input_tokens", 0) * price_in * read) / 1_000_000


def test_live_layers_1_to_3_on_lv11():
    from analysis.layer3.provider import AnthropicProvider

    extraction = AnthropicProvider(os.environ.get("ANALYSIS_L3_MODEL") or DEFAULT_ANTHROPIC_MODEL, timeout=60)
    auditor = AnthropicProvider(os.environ.get("ANALYSIS_L3_AUDIT_MODEL") or DEFAULT_ANTHROPIC_AUDIT_MODEL, timeout=60)
    analysis_input = AnalysisInput.model_validate_json(FIXTURE.read_text(encoding="utf-8")).with_hash()
    layers_1_2 = analyze(analysis_input, [1, 2])

    errors: list[str] = []
    started = time.monotonic()
    findings = layer3.run(analysis_input, layers_1_2.findings, errors, provider=extraction,
                          audit_provider=auditor, cache=ResponseCache(None))
    duration = time.monotonic() - started

    total = cost(extraction.model, extraction.usage) + cost(auditor.model, auditor.usage)
    print(f"\nlayer 3 live: {duration:.1f} s, ${total:.4f}")
    print(f"  {extraction.model}: {extraction.usage}")
    print(f"  {auditor.model}: {auditor.usage}")
    for finding in findings:
        print(f"  {finding.severity:7} {finding.rule_id:32} {finding.target.line_code or '-':8} {finding.message[:90]}")
    for error in errors:
        print(f"  error: {error}")

    by_rule: dict[str, set[str]] = {}
    for finding in findings:
        by_rule.setdefault(finding.rule_id, set()).add(finding.target.line_code)
    assert by_rule.get("L3.PRECAST.MISSING_SPEC", set()) >= {"3.2.20", "3.2.30", "3.2.40", "3.2.50", "3.2.60"}
    assert "3.2.70" in by_rule.get("L3.SCOPE.REBAR_AMBIGUOUS", set())
    assert all(finding.severity in ("warning", "info") for finding in findings)
    assert duration < 90
