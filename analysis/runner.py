"""Standalone runner for layer 2, optionally merging findings from layer 1."""

from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4

from .adapter import canonical_hash
from .contracts import AnalysisInput, AnalysisResult, Finding
from .layer2.engine import ScopeMode, run as run_layer2
from .layer2.schema import RuleSpec


def analyze(input: AnalysisInput, prior_findings: list[Finding] | None = None, *,
            rules: list[RuleSpec] | None = None, scope: ScopeMode = "auto",
            tolerance: Decimal = Decimal("0.10")) -> AnalysisResult:
    prior = list(prior_findings or [])
    if any(finding.layer != 1 for finding in prior):
        raise ValueError("This layer 2 runner accepts prior findings from layer 1 only")
    findings = prior + run_layer2(input, prior, rules=rules, scope=scope, tolerance=tolerance)
    summary = {"total": len(findings)}
    for field in ("layer", "severity", "category", "rule_id"):
        key = "by_rule" if field == "rule_id" else f"by_{field}"
        summary[key] = dict(sorted(Counter(str(getattr(finding, field)) for finding in findings).items()))
    summary["import_warning_count"] = len(input.import_warnings)
    return AnalysisResult(
        run_id=str(uuid4()), bom_version_id=input.bom.bom_version_id,
        input_hash=canonical_hash(input), created_at=datetime.now(timezone.utc),
        layers_run=[2], findings=findings, summary=summary,
    )

