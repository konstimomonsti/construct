"""L3.QTY.IMPLAUSIBLE: a quantity that doesn't fit the described work or its sibling lines.

One call per section (up to 40 lines: code, short text, quantity, unit; no long texts). Only sections
with at least two quantified lines are sent, and only lines that have a quantity can be reported. Lines
with a layer 1 error on the quantity or unit are left out (their values aren't reliable).
"""

from __future__ import annotations

from decimal import Decimal
import re

from ... import units
from ...contracts import Fix, Line
from ...registry import rule
from .. import prompts
from ..common import batches, current, l1_error_fields, line_label
from ..provider import LLMRequest
from ..schema import QUANTITY_SCHEMA, QuantityItem, clamp_confidence, items

RULE_ID = "L3.QTY.IMPLAUSIBLE"
MAX_LINES = 40
MIN_LINES = 2
_ONE_OFF = re.compile(r"\b(?:Baustelleneinrichtung|Werkstattzeichnungen)\b", re.I)
_EXPECTED_MEASURE = re.compile(r"\s*~?\s*(\d+(?:[.,]\d+)?)\s+(\S+?)(?:\s+\([^)]*\))?\s*")


def _quantity_text(quantity: Decimal) -> str:
    number = format(quantity, "f")
    return number.rstrip("0").rstrip(".") if "." in number else number


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
                    "quantity": _quantity_text(line.quantity), "unit": line.unit_raw or line.unit}
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
            expected = _EXPECTED_MEASURE.fullmatch(item.expected)
            comparison = units.convert(Decimal(expected[1].replace(",", ".")),
                                       units.normalize(expected[2]), line.unit) if expected else None
            cited = refs.get((item.comparison_ref or "").strip())
            cited_quantity = (
                units.convert(cited.quantity, cited.unit, line.unit)
                if cited is not None and cited.id != line.id else None
            )
            one_off = line.unit == "lump_sum" and line.quantity > 1 and comparison == 1 and _ONE_OFF.search(line.short_text)
            if comparison is None or comparison == line.quantity or (cited_quantity != comparison and not one_off):
                session.dropped[RULE_ID] += 1
                continue
            seen.add(line.id)
            use_citation = cited_quantity == comparison
            comparison_evidence = ({"line_code": cited.code, "quantity": _quantity_text(cited.quantity),
                                    "unit": cited.unit_raw or cited.unit, "source_locator": cited.source_locator}
                                   if use_citation else {"basis": "one-off lump-sum position"})
            if use_citation:
                stated = f"{comparison_evidence['quantity']} {comparison_evidence['unit']}"
                basis = f"Compare position {cited.code or cited.id}, which states {stated}."
            else:
                basis = "Confirm whether this lump-sum position was intended to be counted once."
            quantity = f"{_quantity_text(line.quantity)} {line.unit_raw or line.unit or ''}".strip()
            yield ctx.finding(
                line=line, field="quantity", origin="llm", model=session.model_id,
                message=f"{line_label(line)}: review the stated quantity of {quantity}. {item.reason.strip()} {basis}",
                related_line_ids=[cited.id] if use_citation else [],
                evidence={"quantity": format(line.quantity, "f"), "unit": line.unit_raw or line.unit,
                          "reason": item.reason.strip(), "expected": item.expected.strip(), "comparison": comparison_evidence,
                          "confidence": clamp_confidence(item.confidence),
                          "prompt_version": prompts.QUANTITY_VERSION},
                suggested_fix=Fix(operations=[], confidence=clamp_confidence(item.confidence),
                                  rationale="Check the source quantity, billing unit, and takeoff. "
                                            "Use the approved quantity after reconciling the scope."),
            )
