"""Deterministic graph and hierarchy integrity rules."""

from ..graph import validate_graph
from ..registry import rule


@rule("L1.STRUCT.GRAPH_INTEGRITY", layer=1, category="structure", severity="error",
      title="Graph and hierarchy integrity",
      description="Hierarchy cycles, self-links, missing parents, bad alternatives, or orphan allocations.")
def graph_integrity(ctx):
    graph = validate_graph(ctx.input)
    for finding in graph.to_findings():
        yield finding
