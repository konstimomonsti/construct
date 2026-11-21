"""Layer 1: deterministic checks (completeness, units, arithmetic, prices, structure, text)."""

from ..contracts import AnalysisInput, Finding
from ..registry import run_layer

# Rule modules register themselves on import. Add new modules here.
from . import arithmetic, completeness, consistency, din, precast, pricing, text_defects, text_quality  # noqa: F401

LAYER = 1


def run(analysis_input: AnalysisInput, prior_findings: list[Finding], errors: list[str] | None = None) -> list[Finding]:
    return run_layer(LAYER, analysis_input, prior_findings, errors)
