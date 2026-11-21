"""Run the analysis layers in order and merge their findings into one AnalysisResult.

Each layer is a package `analysis.layer<N>` exposing

    run(input: AnalysisInput, prior_findings: list[Finding], errors: list[str]) -> list[Finding]

A layer package that does not exist yet is skipped and reported in `errors`.
"""

from __future__ import annotations

from collections import Counter
import importlib
from typing import Iterable

from .contracts import AnalysisInput, AnalysisResult, Finding, Summary
from .graph import validate_graph
from .layer1.arithmetic import working_totals
from .layer3 import empty_outcome
from .questions import build_questions
from .risk import assess

DEFAULT_LAYERS = (1, 2)
_SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}


def analyze(analysis_input: AnalysisInput, layers: Iterable[int] = DEFAULT_LAYERS, *,
            include_risk: bool = True) -> AnalysisResult:
    if not analysis_input.input_hash:
        analysis_input = analysis_input.with_hash()
    graph = validate_graph(analysis_input)
    findings: list[Finding] = []
    errors: list[str] = []
    layers_run: list[int] = []
    l3_status = empty_outcome("disabled", "Layer 3 was not requested")
    for layer in sorted(set(layers)):
        try:
            module = importlib.import_module(f"analysis.layer{layer}")
        except ModuleNotFoundError as exc:
            if exc.name != f"analysis.layer{layer}":
                raise
            errors.append(f"layer {layer}: not implemented yet")
            continue
        try:
            findings.extend(module.run(analysis_input, list(findings), errors))
        except Exception:
            if layer != 3:
                raise
            errors = [error for error in errors if not error.startswith("layer 3 coverage:")]
            errors.extend(["layer 3: advisory checks failed unexpectedly", "layer 3 coverage: 0/0 batches"])
            l3_status = empty_outcome("unavailable", "Advisory checks failed unexpectedly")
            continue
        if layer == 3:
            l3_status = module.get_last_outcome() or empty_outcome("unavailable", "Advisory outcome is missing")
        layers_run.append(layer)

    findings = _sorted(_dedupe(findings), analysis_input)
    risk, questions = None, []
    if include_risk:
        try:
            risk = assess(analysis_input, findings)
            questions = build_questions(analysis_input, findings, risk)
        except Exception as exc:
            errors.append(f"risk report: {type(exc).__name__}: {exc}")
            risk, questions = None, []
    return AnalysisResult(
        bom_version_id=analysis_input.bom.bom_version_id, input_hash=analysis_input.input_hash,
        layers_run=layers_run, findings=findings, summary=summarize(findings), errors=errors,
        risk=risk, questions=questions, l3_status=l3_status, graph_valid=graph.is_valid,
        totals=working_totals(analysis_input, graph),
    )


def _dedupe(findings: list[Finding]) -> list[Finding]:
    seen: dict[str, Finding] = {}
    for finding in findings:
        seen.setdefault(finding.id, finding)
    return list(seen.values())


def _sorted(findings: list[Finding], analysis_input: AnalysisInput) -> list[Finding]:
    order = {line.id: line.sort_order for line in analysis_input.lines}
    return sorted(findings, key=lambda f: (
        _SEVERITY_ORDER.get(f.severity, 9), order.get(f.target.line_id, -1), f.layer, f.rule_id, f.id,
    ))


def summarize(findings: list[Finding]) -> Summary:
    return Summary(
        total=len(findings),
        by_layer=dict(Counter(str(f.layer) for f in findings)),
        by_severity=dict(Counter(f.severity for f in findings)),
        by_category=dict(Counter(f.category for f in findings)),
        by_rule=dict(Counter(f.rule_id for f in findings)),
    )
