"""L3.QTY.IMPLAUSIBLE: a quantity that doesn't fit the described work or its sibling lines.

One call per section (up to 40 lines: code, short text, quantity, unit; no long texts). Only sections
with at least two quantified lines are sent, and only lines that have a quantity can be reported. Lines
with a layer 1 error on the quantity or unit are left out (their values aren't reliable).
"""

from __future__ import annotations

from ...contracts import Line
from ...registry import rule
from .. import prompts
from ..common import batches, current, l1_error_fields, line_label
from ..provider import LLMRequest
from ..schema import QUANTITY_SCHEMA, QuantityItem, clamp_confidence, items

RULE_ID = "L3.QTY.IMPLAUSIBLE"
MAX_LINES = 40
MIN_LINES = 2


@rule(RULE_ID, layer=3, category="quantity", severity="warning", title="Quantity implausible",
      description="The quantity doesn't fit the described work or the sibling lines of its section "
                  "(50 x site set-up, 0.5 m² of facade). LLM check per section on short text, quantity, unit.")
def implausible_quantity(ctx):
    session = current()
    blocked = l1_error_fields(ctx.prior_findings)
    by_section: dict[str | None, list[Line]] = {}
    for line in sorted(ctx.input.lines, key=lambda l: l.sort_order):
        if line.quantity is not None and line.short_text \
                and not blocked.get(line.id, set()) & {"quantity", "unit"}:
            by_section.setdefault(line.section_id, []).append(line)
    titles = {section.id: section.title for section in ctx.input.sections}
    chunks: list[tuple[str | None, list[Line]]] = []
    for section_id, section_lines in by_section.items():
        if len(section_lines) < MIN_LINES:
            continue
        sized = [(line, len(line.short_text or "") + 40) for line in section_lines]
        chunks.extend((section_id, chunk) for chunk in batches(sized, session.max_batch_chars, MAX_LINES))
    requests = []
    for section_id, chunk in chunks:
        payload = [{"ref": f"#{index}", "code": line.code, "short_text": line.short_text,
                    "quantity": format(line.quantity, "f"), "unit": line.unit_raw or line.unit}
                   for index, line in enumerate(chunk, start=1)]
        requests.append(LLMRequest(system=prompts.QUANTITY_SYSTEM,
                                   prompt=prompts.quantity_prompt(titles.get(section_id), payload),
                                   schema=QUANTITY_SCHEMA, prompt_version=prompts.QUANTITY_VERSION))
    for (_, chunk), answer in zip(chunks, session.ask_many(RULE_ID, requests)):
        if answer is None:
            continue
        answers, dropped = items(answer, "findings", QuantityItem)
        session.dropped[RULE_ID] += dropped
        refs = {f"#{index}": line for index, line in enumerate(chunk, start=1)}
        seen: set[str] = set()
        for item in answers:
            line = refs.get(item.line_ref.strip())
            if line is None or line.id in seen:
                session.dropped[RULE_ID] += 1
                continue
            seen.add(line.id)
            quantity = f"{format(line.quantity, 'f')} {line.unit_raw or line.unit or ''}".strip()
            yield ctx.finding(
                line=line, field="quantity", origin="llm", model=session.model_id,
                message=f"{line_label(line)}: quantity {quantity} looks implausible. {item.reason.strip()}"
                        + (f" Expected about {item.expected.strip()}." if item.expected.strip() else ""),
                evidence={"quantity": format(line.quantity, "f"), "unit": line.unit_raw or line.unit,
                          "reason": item.reason.strip(), "expected": item.expected.strip(),
                          "confidence": clamp_confidence(item.confidence),
                          "prompt_version": prompts.QUANTITY_VERSION},
            )
