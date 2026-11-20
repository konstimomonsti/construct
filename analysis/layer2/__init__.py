"""Dependency checks registered with the existing shared analysis runner."""

from ..contracts import AnalysisInput, Finding
from ..registry import rule as register_rule, run_layer
from .engine import run as _engine_run
from .schema import load_rules

LAYER = 2


def _register(rule_spec, dependency):
    check = rule_spec.model_copy(update={"dependencies": [dependency]})

    @register_rule(
        f"{rule_spec.rule_id}_NEEDS_{dependency.key}", layer=2, category="dependency",
        severity="warning", title=f"{dependency.name} dependency",
        description=f"{rule_spec.category} requires {dependency.name.lower()} ({dependency.check_type}).",
    )
    def evaluate(context):
        return _engine_run(context.input, context.prior_findings, rules=[check])


for _rule in load_rules():
    for _dependency in _rule.dependencies:
        _register(_rule, _dependency)


def run(input: AnalysisInput, prior_findings: list[Finding], errors: list[str] | None = None,
        **options) -> list[Finding]:
    """Support the two-argument contract and the shared runner's error collector."""
    if options:
        return _engine_run(input, prior_findings, **options)
    return run_layer(LAYER, input, prior_findings, errors)

__all__ = ["run"]

