"""Standalone runner for layer 2, optionally merging findings from layer 1."""

from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4

from .adapter import canonical_hash
from ..contracts import AnalysisInput, AnalysisResult, Finding
from ..runner import summarize
from .engine import ScopeMode, run as run_layer2
from .schema import RuleSpec


def analyze(input: AnalysisInput, prior_findings: list[Finding] | None = None, *,
            rules: list[RuleSpec] | None = None, scope: ScopeMode = "auto",
            tolerance: Decimal = Decimal("0.10")) -> AnalysisResult:
    prior = list(prior_findings or [])
    if any(finding.layer != 1 for finding in prior):
        raise ValueError("This layer 2 runner accepts prior findings from layer 1 only")
    findings = prior + run_layer2(input, prior, rules=rules, scope=scope, tolerance=tolerance)
    return AnalysisResult(
        run_id=str(uuid4()), bom_version_id=input.bom.bom_version_id,
        input_hash=canonical_hash(input), created_at=datetime.now(timezone.utc),
        layers_run=[2], findings=findings, summary=summarize(findings),
    )
