"""L3.TEXT.UNDERSPECIFIED: the item can't be priced from its text (no dimension, material, class, ...).

Only candidates are sent: lines whose long text is missing or shorter than 60 characters, or lines with a
layer 1 text signal (unclear dimension, missing spec attribute, placeholder, unresolved reference). The
model names one `missing_property` from a fixed list, quotes the words that need the value (checked
verbatim in code) and drafts the question. Confidence is capped at 0.6.
"""

from __future__ import annotations

from ...contracts import Line
from ...registry import rule
from .. import prompts
from ..common import batches, current, line_label
from ..provider import LLMRequest
from ..schema import (
    MAX_UNDERSPECIFIED_CONFIDENCE, UNDERSPECIFIED_SCHEMA, UnderspecifiedItem, clamp_confidence, items, quote_in,
)

RULE_ID = "L3.TEXT.UNDERSPECIFIED"
SHORT_LONG_TEXT = 60
L1_SIGNALS = {"L1.TEXT.SPEC_ATTRIBUTE_MISSING", "L1.TEXT.UNCLEAR_DIMENSION", "L1.TEXT.SPEC_PLACEHOLDER",
              "L1.TEXT.REFERENCE_UNRESOLVED"}


def candidates(lines: list[Line], prior_findings) -> list[Line]:
    signalled = {f.target.line_id for f in prior_findings if f.layer == 1 and f.rule_id in L1_SIGNALS}
    return [line for line in sorted(lines, key=lambda l: l.sort_order)
            if (line.short_text or line.long_text)
            and (len((line.long_text or "").strip()) < SHORT_LONG_TEXT or line.id in signalled)]


@rule(RULE_ID, layer=3, category="text", severity="warning", title="Item text underspecified",
      description="The item can't be priced from its text: a price-driving property (dimension, thickness, "
                  "material, class, ...) is missing. Only short or layer-1-flagged items are checked; quotes "
                  "are verified, confidence <= 0.6.")
def underspecified(ctx):
    session = current()
    by_section: dict[str | None, list[Line]] = {}
    for line in candidates(ctx.input.lines, ctx.prior_findings):
        by_section.setdefault(line.section_id, []).append(line)
    chunks = []
    for section_lines in by_section.values():
        sized = [(line, len(line.short_text or "") + len(line.long_text or "") + 80) for line in section_lines]
        chunks.extend(batches(sized, session.max_batch_chars, 25))
    requests = []
    for chunk in chunks:
        payload = [{"ref": f"#{index}", "code": line.code, "short_text": line.short_text,
                    "long_text": line.long_text, "quantity": _plain(line.quantity), "unit": line.unit_raw or line.unit}
                   for index, line in enumerate(chunk, start=1)]
        requests.append(LLMRequest(system=prompts.UNDERSPECIFIED_SYSTEM, prompt=prompts.underspecified_prompt(payload),
                                   schema=UNDERSPECIFIED_SCHEMA, prompt_version=prompts.UNDERSPECIFIED_VERSION))
    for chunk, answer in zip(chunks, session.ask_many(RULE_ID, requests)):
        if answer is None:
            continue
        answers, dropped = items(answer, "findings", UnderspecifiedItem)
        session.dropped[RULE_ID] += dropped
        refs = {f"#{index}": line for index, line in enumerate(chunk, start=1)}
        seen: set[tuple[str, str]] = set()
        for item in answers:
            line = refs.get(item.line_ref.strip())
            if line is None or not quote_in(item.quote, line.short_text, line.long_text) \
                    or (line.id, item.missing_property) in seen:
                session.dropped[RULE_ID] += 1
                continue
            seen.add((line.id, item.missing_property))
            question = item.question_de.strip()
            if not question.startswith("Zu Pos."):
                question = f"Zu Pos. {line.code}: {question}"
            property_name = item.missing_property.replace("_", " ")
            yield ctx.finding(
                line=line, field="long_text", discriminator=item.missing_property, origin="llm",
                model=session.model_id,
                message=f"{line_label(line)}: the text does not state the {property_name} needed to price "
                        f"\"{item.quote.strip()}\".",
                evidence={"missing_property": item.missing_property, "quote": item.quote.strip(),
                          "bieterfrage_de": question,
                          "confidence": min(clamp_confidence(item.confidence), MAX_UNDERSPECIFIED_CONFIDENCE),
                          "prompt_version": prompts.UNDERSPECIFIED_VERSION},
            )


def _plain(value) -> str | None:
    return None if value is None else format(value, "f")
