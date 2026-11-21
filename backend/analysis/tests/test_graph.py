from decimal import Decimal
import pytest

from analysis.contracts import AnalysisInput, Area, Bom, Distribution, Line, Section
from analysis.graph import EdgeKind, IssueKind, validate_graph, validate_section_hierarchy
from analysis.runner import analyze
import workspace_analysis


def test_valid_out_of_order_parents():
    """Child sections appear before parent sections in the list, but hierarchy is acyclic."""
    sections = [
        Section(id="child_2", parent_id="child_1", sort_order=2, title="Sub-sub-lot"),
        Section(id="child_1", parent_id="root", sort_order=1, title="Sub-lot"),
        Section(id="root", parent_id=None, sort_order=0, title="Root Trade"),
    ]
    inp = AnalysisInput(sections=sections, lines=[])
    graph = validate_graph(inp)
    assert graph.is_valid is True
    assert len(graph.issues) == 0
    assert len(graph.invalid_section_ids) == 0
    assert graph.safe_section_subtrees["root"] == {"root", "child_1", "child_2"}
    assert graph.safe_section_subtrees["child_1"] == {"child_1", "child_2"}
    assert graph.safe_section_subtrees["child_2"] == {"child_2"}

    # Also test workspace_analysis.prepare
    payload = {
        "layers": [1],
        "snapshot": {
            "lines": [{"id": "l1", "code": "01.01.0010", "quantity": 1, "unit": "m", "short_text": "text"}],
            "sections": [
                {"id": "child", "parent_id": "parent"},
                {"id": "parent", "parent_id": None},
            ],
        },
    }
    snapshot, layers = workspace_analysis.prepare(payload)
    assert len(snapshot.sections) == 2


def test_deep_trees():
    """Deep trees (e.g. 15 levels) are valid and acyclic."""
    sections = [Section(id=f"sec_0", parent_id=None, sort_order=0)]
    for i in range(1, 15):
        sections.append(Section(id=f"sec_{i}", parent_id=f"sec_{i-1}", sort_order=i))
    inp = AnalysisInput(sections=sections, lines=[])
    graph = validate_graph(inp)
    assert graph.is_valid is True
    assert len(graph.issues) == 0
    assert len(graph.safe_section_subtrees["sec_0"]) == 15


def test_self_links():
    """Self-links on section, area, and line alternatives."""
    inp = AnalysisInput(
        sections=[Section(id="s1", parent_id="s1", sort_order=0)],
        areas=[Area(id="a1", parent_id="a1", name="Room 1")],
        lines=[Line(id="l1", code="01.01.0010", alternative_for="l1", sort_order=0)],
    )
    graph = validate_graph(inp)
    assert graph.is_valid is False
    assert "s1" in graph.invalid_section_ids
    assert "a1" in graph.invalid_area_ids
    assert "l1" in graph.invalid_line_ids

    issues_by_edge = {i.edge_kind: i for i in graph.issues}
    assert issues_by_edge[EdgeKind.SECTION_PARENT].kind == IssueKind.SELF_LINK
    assert issues_by_edge[EdgeKind.AREA_PARENT].kind == IssueKind.SELF_LINK
    assert issues_by_edge[EdgeKind.LINE_ALTERNATIVE].kind == IssueKind.SELF_LINK

    findings = graph.to_findings()
    rule_ids = {f.rule_id for f in findings}
    assert "L1.STRUCT.SELF_LINK" in rule_ids


def test_short_and_long_cycles():
    """Short cycle (A-B-A) and long cycle (A-B-C-D-A)."""
    # Short cycle in sections
    short_sections = [
        Section(id="s1", parent_id="s2", sort_order=0),
        Section(id="s2", parent_id="s1", sort_order=1),
    ]
    graph_short = validate_graph(AnalysisInput(sections=short_sections, lines=[]))
    assert graph_short.is_valid is False
    assert {"s1", "s2"} <= graph_short.invalid_section_ids
    cycle_issue = next(i for i in graph_short.issues if i.kind == IssueKind.CYCLE)
    assert cycle_issue.edge_kind == EdgeKind.SECTION_PARENT

    # Long cycle in areas
    long_areas = [
        Area(id="a1", parent_id="a2", name="A1"),
        Area(id="a2", parent_id="a3", name="A2"),
        Area(id="a3", parent_id="a4", name="A3"),
        Area(id="a4", parent_id="a1", name="A4"),
    ]
    graph_long = validate_graph(AnalysisInput(sections=[], areas=long_areas, lines=[]))
    assert graph_long.is_valid is False
    assert {"a1", "a2", "a3", "a4"} <= graph_long.invalid_area_ids
    area_cycle = next(i for i in graph_long.issues if i.kind == IssueKind.CYCLE)
    assert area_cycle.edge_kind == EdgeKind.AREA_PARENT


def test_missing_parents():
    """Section and area referencing nonexistent parents."""
    inp = AnalysisInput(
        sections=[Section(id="s1", parent_id="nonexistent_sec", sort_order=0)],
        areas=[Area(id="a1", parent_id="nonexistent_area", name="Area 1")],
        lines=[],
    )
    graph = validate_graph(inp)
    assert graph.is_valid is False
    assert "s1" in graph.invalid_section_ids
    assert "a1" in graph.invalid_area_ids
    missing_issues = [i for i in graph.issues if i.kind == IssueKind.MISSING_TARGET]
    assert len(missing_issues) == 2


def test_orphan_positions_and_allocations():
    """Line with nonexistent section_id and distribution with nonexistent area_id."""
    inp = AnalysisInput(
        sections=[Section(id="s1", parent_id=None, sort_order=0)],
        areas=[Area(id="a1", name="Valid Area")],
        lines=[
            Line(
                id="l1",
                code="01.01.0010",
                section_id="missing_section",
                sort_order=0,
                distributions=[Distribution(area_id="missing_area", quantity=Decimal(5))],
            ),
        ],
    )
    graph = validate_graph(inp)
    assert "l1" in graph.invalid_line_ids
    issue_kinds = {(i.edge_kind, i.kind) for i in graph.issues}
    assert (EdgeKind.LINE_SECTION, IssueKind.ORPHAN_LINE) in issue_kinds
    assert (EdgeKind.DISTRIBUTION_AREA, IssueKind.ORPHAN_ALLOCATION) in issue_kinds


def test_bad_alternative_chains_and_cross_scope():
    """Alternative pointing to another alternative, and alternative in a different section."""
    lines = [
        Line(id="base", code="01.01.0010", section_id="s1", sort_order=0),
        Line(id="alt1", code="01.01.0020", section_id="s1", alternative_for="base", sort_order=1),
        Line(id="alt2", code="01.01.0030", section_id="s1", alternative_for="alt1", sort_order=2),  # Chained
        Line(id="alt_cross", code="02.01.0010", section_id="s2", alternative_for="base", sort_order=3),  # Cross-scope
    ]
    sections = [
        Section(id="s1", parent_id=None, sort_order=0),
        Section(id="s2", parent_id=None, sort_order=1),
    ]
    inp = AnalysisInput(sections=sections, lines=lines)
    graph = validate_graph(inp)
    issue_kinds = {i.kind for i in graph.issues}
    assert IssueKind.BAD_ALTERNATIVE_CHAIN in issue_kinds
    assert IssueKind.CROSS_SCOPE_ALTERNATIVE in issue_kinds


def test_invalid_branches_not_reported_as_authoritative_zero_and_valid_results_stay_available():
    """Invalid branch (cycle) does not crash, is not counted as 0 difference, and valid section is checked."""
    valid_sec = Section(id="valid_s", parent_id=None, sort_order=0, stated_total=Decimal(50))
    cyclic_s1 = Section(id="c1", parent_id="c2", sort_order=1, stated_total=Decimal(100))
    cyclic_s2 = Section(id="c2", parent_id="c1", sort_order=2, stated_total=Decimal(100))

    valid_line = Line(
        id="l_valid",
        code="01.01.0010",
        short_text="Valid item",
        unit="m",
        quantity=Decimal(5),
        price=None,
        source_amounts=None,
        section_id="valid_s",
        sort_order=0,
    )
    cyclic_line = Line(
        id="l_cyclic",
        code="02.01.0010",
        short_text="Cyclic item",
        unit="m",
        quantity=Decimal(10),
        section_id="c1",
        sort_order=1,
    )

    inp = AnalysisInput(
        sections=[valid_sec, cyclic_s1, cyclic_s2],
        lines=[valid_line, cyclic_line],
        bom=Bom(stated_net_total=Decimal(250)),
    )

    res = analyze(inp, layers=[1])
    assert res.errors == []

    rule_ids = {f.rule_id for f in res.findings}
    # Structural rule must flag the cycle
    assert "L1.STRUCT.CYCLE" in rule_ids

    # Section total on cyclic sections must NOT be reported as 0.00
    section_findings = [f for f in res.findings if f.rule_id == "L1.ARITH.SECTION_TOTAL"]
    reported_sec_ids = {f.target.section_id for f in section_findings}
    assert "c1" not in reported_sec_ids
    assert "c2" not in reported_sec_ids

    # Valid results stay available (e.g. valid section checks or other rules)
    assert any(f.target.section_id == "valid_s" or f.target.line_id == "l_valid" for f in res.findings)
