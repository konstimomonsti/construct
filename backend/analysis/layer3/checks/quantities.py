"""L3.QTY.IMPLAUSIBLE: a quantity that doesn't fit the described work or its sibling lines.

Small sections share a call (up to 40 lines: code, short text, quantity, unit; no long texts). Only sections
with at least two quantified lines are sent, and only lines that have a quantity can be reported. Lines
with a layer 1 error on the quantity or unit are left out (their values aren't reliable).
"""

from __future__ import annotations

import json
import re

from ...contracts import Line
from ...registry import rule
from .. import prompts
from ..common import batches, current, l1_error_fields, line_label, packed_sections
from ..provider import LLMRequest
from ..schema import QUANTITY_SCHEMA, QuantityItem, clamp_confidence, items

RULE_ID = "L3.QTY.IMPLAUSIBLE"
MAX_LINES = 40
MIN_LINES = 2


@rule(RULE_ID, layer=3, category="quantity", severity="warning", title="Quantity implausible",
      description="The quantity doesn't fit the described work or the sibling lines of its section "
                  "(50 x site set-up, 0.5 m² of facade). LLM check on short text, quantity, unit.")
def implausible_quantity(ctx):
    session = current()
    blocked = l1_error_fields(ctx.prior_findings)
    by_section: dict[str | None, list[Line]] = {}
    for line in sorted(ctx.input.lines, key=lambda l: l.sort_order):
        if line.quantity is not None and line.short_text \
                and not blocked.get(line.id, set()) & {"quantity", "unit"}:
            by_section.setdefault(line.section_id, []).append(line)
    titles = {section.id: f"{section.code or section.id} {section.title or ''}".strip()
              for section in ctx.input.sections}
    chunks: list[tuple[str | None, list[Line]]] = []
    sizes = {}
    char_limit = max(1, session.max_batch_chars - 200)  # prompt header and section wrapper
    for section_id, section_lines in by_section.items():
        if len(section_lines) < MIN_LINES:
            continue
        sized = [(line, len(json.dumps({"ref": "#40", "code": line.code, "short_text": line.short_text,
                                       "quantity": format(line.quantity, "f"), "unit": line.unit_raw or line.unit,
                                       "section": titles.get(section_id) or section_id or "Ohne Abschnitt"},
                                      ensure_ascii=False, indent=1)) + 4) for line in section_lines]
        sizes.update((line.id, size) for line, size in sized)
        chunks.extend((section_id, chunk) for chunk in batches(sized, char_limit, MAX_LINES))
    groups = list(packed_sections(chunks, sizes, char_limit, MAX_LINES))
    requests = []
    for group in groups:
        chunk = [(section_id, line) for section_id, lines in group for line in lines]
        multi_section = len({section_id for section_id, _ in chunk}) > 1
        payload = [{"ref": f"#{index}", "code": line.code, "short_text": line.short_text,
                    "quantity": format(line.quantity, "f"), "unit": line.unit_raw or line.unit,
                    **({"section": titles.get(section_id) or section_id or "Ohne Abschnitt"} if multi_section else {})}
                   for index, (section_id, line) in enumerate(chunk, start=1)]
        system = prompts.QUANTITY_SYSTEM
        if multi_section:
            system += "\nSeveral sections are included. Compare siblings only within the same section label."
        requests.append(LLMRequest(system=system,
                                   prompt=prompts.quantity_prompt("Multiple sections" if multi_section else
                                                                  titles.get(chunk[0][0]), payload),
                                   schema=QUANTITY_SCHEMA, prompt_version=prompts.QUANTITY_VERSION))
    for group, answer in zip(groups, session.ask_many(RULE_ID, requests)):
        if answer is None:
            continue
        answers, dropped = items(answer, "findings", QuantityItem)
        session.dropped[RULE_ID] += dropped
        refs = {f"#{index}": line for index, line in enumerate(
            (line for _, section_lines in group for line in section_lines), start=1)}
        seen: set[str] = set()
        for item in answers:
            line = refs.get(item.line_ref.strip())
            if line is None or line.id in seen:
                session.dropped[RULE_ID] += 1
                continue
            seen.add(line.id)
            quantity = f"{format(line.quantity, 'f')} {line.unit_raw or line.unit or ''}".strip()
            expected = item.expected.strip()
            has_comparison = bool(re.search(r"\d", expected))
            comparison = (f" AI comparison: {expected}." if has_comparison
                          else " Check the quantity against the takeoff.")
            yield ctx.finding(
                line=line, field="quantity", origin="llm", model=session.model_id,
                severity="warning" if has_comparison else "info",
                message=f"{line_label(line)}: check quantity {quantity}. {item.reason.strip()}" + comparison,
                evidence={"quantity": format(line.quantity, "f"), "unit": line.unit_raw or line.unit,
                          "reason": item.reason.strip(), "expected": item.expected.strip(),
                          "confidence": clamp_confidence(item.confidence),
                          "prompt_version": prompts.QUANTITY_VERSION},
            )
