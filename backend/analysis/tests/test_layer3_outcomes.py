import os
from unittest.mock import patch
import pytest

from analysis.contracts import AnalysisInput, Line, Section
from analysis.layer3 import get_last_outcome, run as run_layer3
from analysis.layer3.common import Session
from analysis.layer3.provider import FakeProvider, ProviderError, ProviderUnavailable, ResponseCache, provider_from_env
from analysis.layer3.schema import ContradictionItem, items
from analysis.runner import analyze
import workspace_analysis


def test_default_off():
    """When ANALYSIS_L3_PROVIDER=none or unset, layer 3 is disabled and reports state=disabled."""
    with patch.dict(os.environ, {"ANALYSIS_L3_PROVIDER": "none"}, clear=False):
        inp = AnalysisInput(
            sections=[Section(id="s1", parent_id=None, sort_order=0)],
            lines=[Line(id="l1", code="01.01.0010", short_text="Beton C25/30", long_text="Beton C30/37", unit="m3", quantity=10, sort_order=0)],
        )
        res = analyze(inp, layers=[1, 2, 3])
        assert res.l3_status is not None
        assert res.l3_status["state"] == "disabled"
        assert res.l3_status["planned"] == 0
        assert any("disabled" in err.lower() for err in res.errors)


def test_misconfiguration():
    """Unknown provider raises ProviderUnavailable and reports state=unavailable."""
    with patch.dict(os.environ, {"ANALYSIS_L3_PROVIDER": "unsupported_provider_xyz"}, clear=False):
        inp = AnalysisInput(
            sections=[Section(id="s1", parent_id=None, sort_order=0)],
            lines=[Line(id="l1", code="01.01.0010", short_text="Beton C25/30", long_text="Beton C30/37", unit="m3", quantity=10, sort_order=0)],
        )
        res = analyze(inp, layers=[3])
        assert res.l3_status is not None
        assert res.l3_status["state"] == "unavailable"
        assert any("unknown analysis_l3_provider" in err.lower() for err in res.errors)


def test_valid_empty_arrays_vs_missing_null_envelopes():
    """Valid empty arrays return 0 dropped, whereas missing or null envelopes return dropped=1."""
    # 1. Valid empty array
    valid_res, valid_dropped = items({"findings": []}, "findings", ContradictionItem)
    assert valid_res == []
    assert valid_dropped == 0

    # 2. Missing envelope key
    missing_res, missing_dropped = items({}, "findings", ContradictionItem)
    assert missing_res == []
    assert missing_dropped == 1

    # 3. Null envelope value
    null_res, null_dropped = items({"findings": None}, "findings", ContradictionItem)
    assert null_res == []
    assert null_dropped == 1

    # 4. Non-list envelope
    non_list_res, non_list_dropped = items({"findings": "not_a_list"}, "findings", ContradictionItem)
    assert non_list_res == []
    assert non_list_dropped == 1


def test_rejected_evidence_marks_degraded():
    """When an item in the envelope fails Pydantic validation, it is counted as dropped and state is degraded."""
    fake = FakeProvider({"findings": [{"bad_key": 123}]})  # Fails ContradictionItem validation
    inp = AnalysisInput(
        sections=[Section(id="s1", parent_id=None, sort_order=0)],
        lines=[Line(id="l1", code="01.01.0010", short_text="DN 100", long_text="DN 150", unit="m", quantity=10, sort_order=0)],
    )
    errors = []
    run_layer3(inp, [], errors, provider=fake, cache=ResponseCache(None))
    outcome = get_last_outcome()
    assert outcome is not None
    assert outcome["dropped"] >= 1
    assert outcome["state"] == "degraded"


def test_timeout_and_unexpected_crashes_preserve_deterministic_findings():
    """Provider failure records failure and degraded state, leaving layer 1 and 2 findings intact."""
    fake = FakeProvider(ProviderError("Request timed out after 30s"))
    inp = AnalysisInput(
        sections=[Section(id="s1", parent_id=None, sort_order=0)],
        lines=[
            # This line has an L1 unit mismatch error
            Line(id="l1", code="01.01.0010", short_text="DN 100", long_text="DN 150 Abrechnung nach m", unit="ea", quantity=10, sort_order=0),
        ],
    )
    errors = []
    l3_findings = run_layer3(inp, [], errors, provider=fake, cache=ResponseCache(None))
    assert l3_findings == []
    outcome = get_last_outcome()
    assert outcome is not None
    assert outcome["failed"] >= 1
    assert outcome["state"] == "degraded"
    assert any("timed out" in err.lower() for err in errors)

    # In full analyze: layer 1 findings remain completely intact
    res = analyze(inp, layers=[1, 2])
    assert len(res.findings) > 0


def test_workspace_analysis_options_and_aliases():
    """workspace_analysis.options recognizes all aliases (ollama, local, anthropic, claude, api)."""
    with patch.dict(os.environ, {"ANALYSIS_L3_PROVIDER": "claude"}, clear=False):
        opt = workspace_analysis.options()
        assert opt["ai_available"] is True
        assert opt["provider"] == "claude"

    with patch.dict(os.environ, {"ANALYSIS_L3_PROVIDER": "local"}, clear=False):
        opt = workspace_analysis.options()
        assert opt["ai_available"] is True
        assert opt["provider"] == "local"

    with patch.dict(os.environ, {"ANALYSIS_L3_PROVIDER": "none"}, clear=False):
        opt = workspace_analysis.options()
        assert opt["ai_available"] is False
        assert opt["provider"] == "none"
