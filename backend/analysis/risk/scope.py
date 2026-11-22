"""Position and section selection shared by the risk score and bidder questions."""

import re

from ..contracts import AnalysisInput, Finding, Line


def anchor(finding: Finding, lines: dict[str, Line]) -> str | None:
    if finding.target.line_id in lines:
        return finding.target.line_id
    related = [lines[id] for id in finding.related_line_ids if id in lines]
    return min(related, key=lambda line: (line.sort_order, line.id)).id if related else None


def excluded_sections(analysis_input: AnalysisInput) -> set[str]:
    sections = analysis_input.section_by_id()
    excluded = set()
    for id in sections:
        current, seen = id, set()
        while current in sections and current not in seen:
            seen.add(current)
            section = sections[current]
            if re.search(r"\bnachtr(?:ag|äge)\b", section.title or "", re.I):
                excluded.add(id)
                break
            current = section.parent_id
    return excluded
