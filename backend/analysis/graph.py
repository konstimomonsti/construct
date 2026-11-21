"""Shared graph and reference validator for tender hierarchies and links.

Validates:
- Section hierarchy (parent_id references, self-links, short and long cycles, out-of-order parents, deep trees)
- Area hierarchy (parent_id references, self-links, cycles)
- Line-to-section placement (orphan lines, missing sections, invalid section branches)
- Area distributions (allocations to missing or cyclic areas)
- Alternative line links (alternative_for self-links, cycles, missing base lines, chained alternatives, cross-scope links)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterable

from .contracts import (
    AnalysisInput, Area, Finding, Line, Scope, Section, Severity, Target, finding_key,
)


class EdgeKind(str, Enum):
    SECTION_PARENT = "section_parent"
    AREA_PARENT = "area_parent"
    LINE_SECTION = "line_section"
    LINE_ALTERNATIVE = "line_alternative"
    DISTRIBUTION_AREA = "distribution_area"


class IssueKind(str, Enum):
    CYCLE = "cycle"
    SELF_LINK = "self_link"
    MISSING_TARGET = "missing_target"
    ORPHAN_LINE = "orphan_line"
    ORPHAN_ALLOCATION = "orphan_allocation"
    BAD_ALTERNATIVE_CHAIN = "bad_alternative_chain"
    CROSS_SCOPE_ALTERNATIVE = "cross_scope_alternative"
    DISCONNECTED_COMPONENT = "disconnected_component"


@dataclass
class GraphIssue:
    kind: IssueKind
    edge_kind: EdgeKind
    source_id: str
    target_id: str | None = None
    cycle_path: list[str] | None = None
    message: str = ""
    source_locator: dict[str, Any] = field(default_factory=dict)
    line_code: str | None = None
    section_code: str | None = None


@dataclass
class GraphValidationResult:
    is_valid: bool
    issues: list[GraphIssue] = field(default_factory=list)

    # Invalid IDs (involved in cycles, self-links, missing parents, or their descendants)
    invalid_section_ids: set[str] = field(default_factory=set)
    invalid_area_ids: set[str] = field(default_factory=set)
    invalid_line_ids: set[str] = field(default_factory=set)

    # Valid parent-child adjacency for acyclic traversal (only valid acyclic edges)
    safe_section_children: dict[str | None, list[str]] = field(default_factory=dict)
    # section_id -> set of descendant section_ids (including self)
    safe_section_subtrees: dict[str, set[str]] = field(default_factory=dict)

    safe_area_children: dict[str | None, list[str]] = field(default_factory=dict)
    safe_area_subtrees: dict[str, set[str]] = field(default_factory=dict)

    def to_findings(self) -> list[Finding]:
        findings: list[Finding] = []
        for issue in self.issues:
            rule_id: str
            severity: Severity
            scope: Scope
            target: Target

            if issue.edge_kind in (EdgeKind.SECTION_PARENT, EdgeKind.AREA_PARENT):
                scope = Scope.SECTION if issue.edge_kind == EdgeKind.SECTION_PARENT else Scope.AREA
                target = Target(section_id=issue.source_id) if scope == Scope.SECTION else Target(area_id=issue.source_id)
                if issue.kind == IssueKind.SELF_LINK:
                    rule_id = "L1.STRUCT.SELF_LINK"
                    severity = Severity.ERROR
                    title = "Self-referencing hierarchy element"
                elif issue.kind == IssueKind.CYCLE:
                    rule_id = "L1.STRUCT.CYCLE"
                    severity = Severity.ERROR
                    title = "Cyclic hierarchy dependency"
                elif issue.kind == IssueKind.MISSING_TARGET:
                    rule_id = "L1.STRUCT.MISSING_PARENT"
                    severity = Severity.ERROR
                    title = "Missing parent in hierarchy"
                else:
                    rule_id = "L1.STRUCT.DISCONNECTED"
                    severity = Severity.ERROR
                    title = "Disconnected component"

            elif issue.edge_kind == EdgeKind.LINE_SECTION:
                scope = Scope.LINE
                target = Target(line_id=issue.source_id, line_code=issue.line_code, field="section")
                rule_id = "L1.STRUCT.ORPHAN_LINE"
                severity = Severity.WARNING
                title = "Position references nonexistent or invalid section"

            elif issue.edge_kind == EdgeKind.DISTRIBUTION_AREA:
                scope = Scope.LINE
                target = Target(line_id=issue.source_id, line_code=issue.line_code, area_id=issue.target_id, field="distributions")
                rule_id = "L1.STRUCT.ORPHAN_ALLOCATION"
                severity = Severity.WARNING
                title = "Room allocation references nonexistent or invalid area"

            elif issue.edge_kind == EdgeKind.LINE_ALTERNATIVE:
                scope = Scope.LINE
                target = Target(line_id=issue.source_id, line_code=issue.line_code, field="alternative_for")
                if issue.kind == IssueKind.SELF_LINK:
                    rule_id = "L1.STRUCT.SELF_LINK"
                    severity = Severity.ERROR
                    title = "Position is an alternative for itself"
                elif issue.kind == IssueKind.CYCLE:
                    rule_id = "L1.STRUCT.CYCLE"
                    severity = Severity.ERROR
                    title = "Cycle in alternative positions"
                elif issue.kind == IssueKind.MISSING_TARGET:
                    rule_id = "L1.STRUCT.ORPHAN_ALTERNATIVE"
                    severity = Severity.WARNING
                    title = "Alternative position without valid base position"
                elif issue.kind == IssueKind.BAD_ALTERNATIVE_CHAIN:
                    rule_id = "L1.STRUCT.BAD_ALTERNATIVE"
                    severity = Severity.WARNING
                    title = "Chained alternative positions"
                elif issue.kind == IssueKind.CROSS_SCOPE_ALTERNATIVE:
                    rule_id = "L1.STRUCT.CROSS_SCOPE_ALTERNATIVE"
                    severity = Severity.WARNING
                    title = "Cross-scope alternative position"
                else:
                    rule_id = "L1.STRUCT.BAD_ALTERNATIVE"
                    severity = Severity.WARNING
                    title = "Invalid alternative link"
            else:
                continue

            discriminator = f"{issue.kind.value}:{issue.target_id or ''}"
            evidence = {
                "edge_kind": issue.edge_kind.value,
                "issue_kind": issue.kind.value,
                "source_id": issue.source_id,
                "target_id": issue.target_id,
            }
            if issue.cycle_path:
                evidence["cycle_path"] = issue.cycle_path
            if issue.source_locator:
                evidence["source_locator"] = issue.source_locator

            findings.append(Finding.create(
                rule_id=rule_id,
                layer=1,
                target=target,
                discriminator=discriminator,
                category="structure",
                severity=severity,
                scope=scope,
                title=title,
                message=issue.message,
                evidence=evidence,
                source_locator=issue.source_locator or None,
            ))
        return findings


def validate_section_hierarchy(sections: Iterable[dict | Section]) -> tuple[bool, list[str]]:
    """Quick validation of a section hierarchy (e.g. for input pre-validation in workspace_analysis.prepare).

    Accepts valid out-of-order parents and deep trees.
    Returns (is_valid, error_messages).
    """
    sec_map: dict[str, str | None] = {}
    for s in sections:
        s_id = s.id if isinstance(s, Section) else s.get("id")
        p_id = s.parent_id if isinstance(s, Section) else s.get("parent_id")
        if not s_id or not isinstance(s_id, str):
            return False, ["Invalid section ID"]
        sec_map[s_id] = p_id

    errors: list[str] = []
    for s_id, p_id in sec_map.items():
        if p_id is None:
            continue
        if p_id == s_id:
            errors.append(f"Section '{s_id}' references itself as parent.")
            continue
        if p_id not in sec_map:
            errors.append(f"Section '{s_id}' references missing parent '{p_id}'.")
            continue
        # Check cycle
        visited = [s_id]
        curr = p_id
        while curr is not None:
            if curr == s_id or curr in visited:
                errors.append(f"Cycle detected in section hierarchy containing '{curr}'.")
                break
            if curr not in sec_map:
                break
            visited.append(curr)
            curr = sec_map[curr]

    return len(errors) == 0, errors


def validate_graph(analysis_input: AnalysisInput) -> GraphValidationResult:
    """Validate all graph references, ancestry, alternatives, and allocations."""
    issues: list[GraphIssue] = []
    invalid_section_ids: set[str] = set()
    invalid_area_ids: set[str] = set()
    invalid_line_ids: set[str] = set()

    # 1. Section hierarchy
    sections_by_id = {s.id: s for s in analysis_input.sections}
    section_parent_map: dict[str, str | None] = {}

    for section in analysis_input.sections:
        p_id = section.parent_id
        section_parent_map[section.id] = p_id
        s_code = section.code or section.id

        if p_id is not None:
            if p_id == section.id:
                invalid_section_ids.add(section.id)
                issues.append(GraphIssue(
                    kind=IssueKind.SELF_LINK,
                    edge_kind=EdgeKind.SECTION_PARENT,
                    source_id=section.id,
                    target_id=section.id,
                    cycle_path=[section.id, section.id],
                    message=f"Section {s_code} references itself as parent.",
                    section_code=section.code,
                ))
            elif p_id not in sections_by_id:
                invalid_section_ids.add(section.id)
                issues.append(GraphIssue(
                    kind=IssueKind.MISSING_TARGET,
                    edge_kind=EdgeKind.SECTION_PARENT,
                    source_id=section.id,
                    target_id=p_id,
                    message=f"Section {s_code} references nonexistent parent section '{p_id}'.",
                    section_code=section.code,
                ))

    # Cycle detection in sections
    for section in analysis_input.sections:
        if section.id in invalid_section_ids:
            continue
        visited = [section.id]
        curr = section_parent_map.get(section.id)
        while curr is not None:
            if curr in visited:
                idx = visited.index(curr)
                cycle = visited[idx:] + [curr]
                for c_id in cycle:
                    invalid_section_ids.add(c_id)
                issues.append(GraphIssue(
                    kind=IssueKind.CYCLE,
                    edge_kind=EdgeKind.SECTION_PARENT,
                    source_id=section.id,
                    target_id=curr,
                    cycle_path=cycle,
                    message=f"Cycle detected in section hierarchy: {' -> '.join(cycle)}.",
                    section_code=section.code,
                ))
                break
            if curr in invalid_section_ids:
                invalid_section_ids.add(section.id)
                break
            if curr not in sections_by_id:
                invalid_section_ids.add(section.id)
                break
            visited.append(curr)
            curr = section_parent_map.get(curr)

    # Taint descendants of invalid sections
    changed = True
    while changed:
        changed = False
        for s_id, p_id in section_parent_map.items():
            if p_id in invalid_section_ids and s_id not in invalid_section_ids:
                invalid_section_ids.add(s_id)
                changed = True

    # Build safe section children and subtrees (acyclic)
    safe_section_children: dict[str | None, list[str]] = {}
    for s in analysis_input.sections:
        if s.id not in invalid_section_ids:
            p_id = s.parent_id
            safe_section_children.setdefault(p_id, []).append(s.id)

    safe_section_subtrees: dict[str, set[str]] = {}
    for s in analysis_input.sections:
        if s.id in invalid_section_ids:
            safe_section_subtrees[s.id] = {s.id}
        else:
            sub: set[str] = {s.id}
            queue = [s.id]
            while queue:
                curr_id = queue.pop(0)
                for child_id in safe_section_children.get(curr_id, []):
                    if child_id not in sub:
                        sub.add(child_id)
                        queue.append(child_id)
            safe_section_subtrees[s.id] = sub

    # 2. Area hierarchy
    areas_by_id = {a.id: a for a in analysis_input.areas}
    area_parent_map: dict[str, str | None] = {}

    for area in analysis_input.areas:
        p_id = area.parent_id
        area_parent_map[area.id] = p_id
        if p_id is not None:
            if p_id == area.id:
                invalid_area_ids.add(area.id)
                issues.append(GraphIssue(
                    kind=IssueKind.SELF_LINK,
                    edge_kind=EdgeKind.AREA_PARENT,
                    source_id=area.id,
                    target_id=area.id,
                    cycle_path=[area.id, area.id],
                    message=f"Area '{area.name or area.id}' references itself as parent.",
                ))
            elif p_id not in areas_by_id:
                invalid_area_ids.add(area.id)
                issues.append(GraphIssue(
                    kind=IssueKind.MISSING_TARGET,
                    edge_kind=EdgeKind.AREA_PARENT,
                    source_id=area.id,
                    target_id=p_id,
                    message=f"Area '{area.name or area.id}' references nonexistent parent area '{p_id}'.",
                ))

    # Cycle detection in areas
    for area in analysis_input.areas:
        if area.id in invalid_area_ids:
            continue
        visited = [area.id]
        curr = area_parent_map.get(area.id)
        while curr is not None:
            if curr in visited:
                idx = visited.index(curr)
                cycle = visited[idx:] + [curr]
                for c_id in cycle:
                    invalid_area_ids.add(c_id)
                issues.append(GraphIssue(
                    kind=IssueKind.CYCLE,
                    edge_kind=EdgeKind.AREA_PARENT,
                    source_id=area.id,
                    target_id=curr,
                    cycle_path=cycle,
                    message=f"Cycle detected in area hierarchy: {' -> '.join(cycle)}.",
                ))
                break
            if curr in invalid_area_ids or curr not in areas_by_id:
                invalid_area_ids.add(area.id)
                break
            visited.append(curr)
            curr = area_parent_map.get(curr)

    # Taint descendants of invalid areas
    changed = True
    while changed:
        changed = False
        for a_id, p_id in area_parent_map.items():
            if p_id in invalid_area_ids and a_id not in invalid_area_ids:
                invalid_area_ids.add(a_id)
                changed = True

    safe_area_children: dict[str | None, list[str]] = {}
    for a in analysis_input.areas:
        if a.id not in invalid_area_ids:
            safe_area_children.setdefault(a.parent_id, []).append(a.id)

    safe_area_subtrees: dict[str, set[str]] = {}
    for a in analysis_input.areas:
        if a.id in invalid_area_ids:
            safe_area_subtrees[a.id] = {a.id}
        else:
            sub = {a.id}
            queue = [a.id]
            while queue:
                curr_id = queue.pop(0)
                for child_id in safe_area_children.get(curr_id, []):
                    if child_id not in sub:
                        sub.add(child_id)
                        queue.append(child_id)
            safe_area_subtrees[a.id] = sub

    # 3. Line to section references & distributions
    lines_by_id = {line.id: line for line in analysis_input.lines}

    for line in analysis_input.lines:
        line_label = f"Position {line.code or line.id}"
        if line.section_id is not None:
            if line.section_id not in sections_by_id:
                invalid_line_ids.add(line.id)
                issues.append(GraphIssue(
                    kind=IssueKind.ORPHAN_LINE,
                    edge_kind=EdgeKind.LINE_SECTION,
                    source_id=line.id,
                    target_id=line.section_id,
                    message=f"{line_label} references nonexistent section '{line.section_id}'.",
                    source_locator=line.source_locator,
                    line_code=line.code,
                ))
            elif line.section_id in invalid_section_ids:
                invalid_line_ids.add(line.id)

        # 4. Distributions
        for dist in line.distributions:
            if dist.area_id not in areas_by_id:
                issues.append(GraphIssue(
                    kind=IssueKind.ORPHAN_ALLOCATION,
                    edge_kind=EdgeKind.DISTRIBUTION_AREA,
                    source_id=line.id,
                    target_id=dist.area_id,
                    message=f"{line_label} allocates quantity to nonexistent area '{dist.area_id}'.",
                    source_locator=line.source_locator,
                    line_code=line.code,
                ))
            elif dist.area_id in invalid_area_ids:
                issues.append(GraphIssue(
                    kind=IssueKind.ORPHAN_ALLOCATION,
                    edge_kind=EdgeKind.DISTRIBUTION_AREA,
                    source_id=line.id,
                    target_id=dist.area_id,
                    message=f"{line_label} allocates quantity to invalid area '{dist.area_id}' in broken hierarchy.",
                    source_locator=line.source_locator,
                    line_code=line.code,
                ))

        # 5. Line alternatives
        if line.alternative_for is not None:
            alt_target = line.alternative_for
            if alt_target == line.id:
                invalid_line_ids.add(line.id)
                issues.append(GraphIssue(
                    kind=IssueKind.SELF_LINK,
                    edge_kind=EdgeKind.LINE_ALTERNATIVE,
                    source_id=line.id,
                    target_id=line.id,
                    message=f"{line_label} is marked as alternative for itself.",
                    source_locator=line.source_locator,
                    line_code=line.code,
                ))
            elif alt_target not in lines_by_id:
                invalid_line_ids.add(line.id)
                issues.append(GraphIssue(
                    kind=IssueKind.MISSING_TARGET,
                    edge_kind=EdgeKind.LINE_ALTERNATIVE,
                    source_id=line.id,
                    target_id=alt_target,
                    message=f"{line_label} references nonexistent base position '{alt_target}'.",
                    source_locator=line.source_locator,
                    line_code=line.code,
                ))
            else:
                base_line = lines_by_id[alt_target]
                # Bad alternative chain: base position is itself an alternative
                if base_line.alternative_for is not None:
                    issues.append(GraphIssue(
                        kind=IssueKind.BAD_ALTERNATIVE_CHAIN,
                        edge_kind=EdgeKind.LINE_ALTERNATIVE,
                        source_id=line.id,
                        target_id=base_line.id,
                        message=f"{line_label} is an alternative for position {base_line.code or base_line.id}, which is itself an alternative position.",
                        source_locator=line.source_locator,
                        line_code=line.code,
                    ))

                # Cycle detection in alternatives
                curr_alt = base_line
                alt_visited = [line.id, curr_alt.id]
                while curr_alt.alternative_for is not None:
                    next_alt = curr_alt.alternative_for
                    if next_alt in alt_visited:
                        idx = alt_visited.index(next_alt)
                        cycle = alt_visited[idx:] + [next_alt]
                        for a_id in cycle:
                            invalid_line_ids.add(a_id)
                        issues.append(GraphIssue(
                            kind=IssueKind.CYCLE,
                            edge_kind=EdgeKind.LINE_ALTERNATIVE,
                            source_id=line.id,
                            target_id=next_alt,
                            cycle_path=cycle,
                            message=f"Cycle detected in alternative positions: {' -> '.join(cycle)}.",
                            source_locator=line.source_locator,
                            line_code=line.code,
                        ))
                        break
                    if next_alt not in lines_by_id:
                        break
                    alt_visited.append(next_alt)
                    curr_alt = lines_by_id[next_alt]

                # Cross-scope alternative
                if line.section_id is not None and base_line.section_id is not None and line.section_id != base_line.section_id:
                    issues.append(GraphIssue(
                        kind=IssueKind.CROSS_SCOPE_ALTERNATIVE,
                        edge_kind=EdgeKind.LINE_ALTERNATIVE,
                        source_id=line.id,
                        target_id=base_line.id,
                        message=f"{line_label} (section '{line.section_id}') is an alternative for position {base_line.code or base_line.id} in a different section ('{base_line.section_id}').",
                        source_locator=line.source_locator,
                        line_code=line.code,
                    ))

    is_valid = not bool(invalid_section_ids or invalid_area_ids or any(
        i.kind in (IssueKind.CYCLE, IssueKind.SELF_LINK) for i in issues
    ))

    return GraphValidationResult(
        is_valid=is_valid,
        issues=issues,
        invalid_section_ids=invalid_section_ids,
        invalid_area_ids=invalid_area_ids,
        invalid_line_ids=invalid_line_ids,
        safe_section_children=safe_section_children,
        safe_section_subtrees=safe_section_subtrees,
        safe_area_children=safe_area_children,
        safe_area_subtrees=safe_area_subtrees,
    )
