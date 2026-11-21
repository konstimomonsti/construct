"""L3.TEXT.SHORT_LONG_CONTRADICTION: the short text and the long text state different values."""

from __future__ import annotations

import re

from ...contracts import Line
from ...layer1.common import review_fix
from ...layer1.textvalues import MEASURE, centimetres
from ...registry import rule
from .. import prompts
from ..common import batches, clip, current, l1_error_fields, line_label
from ..provider import LLMRequest
from ..schema import CONTRADICTION_SCHEMA, ContradictionItem, clamp_confidence, items, normalize, quote_in

RULE_ID = "L3.TEXT.SHORT_LONG_CONTRADICTION"
L1_VALUE_CONFLICT = "L1.TEXT.VALUE_CONFLICT"  # layer 1 already reported a conflict on the line: don't repeat
_DIMENSION_PROPERTY = re.compile(r"\b(?:thickness|dimension[s]?|height|length|width|depth|dicke|höhe|länge|breite|tiefe)\b", re.I)
_LENGTH = re.compile(MEASURE, re.I)


# Short texts worth checking carry a value: a number (DN 150, 12,5 mm, C25/30) or a material.
_MATERIAL = re.compile(
    r"\b(kupfer|edelstahl|stahl|verzinkt|aluminium|alu|pvc|pe-?hd|pe|pp|gusseisen|guss|steinzeug|beton|"
    r"stahlbeton|holz|gfk|zink|titanzink|messing|mineralwolle|glaswolle|steinwolle|eps|xps|pur|pir)\b",
    re.IGNORECASE,
)


def is_candidate(line: Line, blocked_fields: set[str]) -> bool:
    if not line.short_text or not line.long_text:
        return False
    if blocked_fields & {"short_text", "long_text"}:
        return False
    if normalize(line.short_text) == normalize(line.long_text):
        return False
    return bool(re.search(r"\d", line.short_text) or _MATERIAL.search(line.short_text))


@rule(RULE_ID, layer=3, category="text", severity="warning", title="Short text contradicts long text",
      description="The short text and the long text state different values for the same property "
                  "(DN, concrete class, thickness, material). LLM check; quotes are verified in code.")
def short_long_contradiction(ctx):
    session = current()
    blocked = l1_error_fields(ctx.prior_findings)
    conflicts = {f.target.line_id for f in ctx.prior_findings if f.rule_id == L1_VALUE_CONFLICT}
    by_section: dict[str | None, list[Line]] = {}
    for line in sorted(ctx.input.lines, key=lambda l: l.sort_order):
        if line.id not in conflicts and is_candidate(line, blocked.get(line.id, set())):
            by_section.setdefault(line.section_id, []).append(line)

    for section_lines in by_section.values():
        sized = [(line, len(line.short_text or "") + min(len(line.long_text or ""), 3_000) + 80)
                 for line in section_lines]
        for batch in batches(sized, session.max_batch_chars, session.max_batch_lines):
            refs = {f"#{index}": line for index, line in enumerate(batch, start=1)}
            payload = [{"ref": ref, "code": line.code, "short_text": line.short_text,
                        "long_text": clip(line.long_text)} for ref, line in refs.items()]
            request = LLMRequest(system=prompts.CONTRADICTION_SYSTEM,
                                 prompt=prompts.contradiction_prompt(payload),
                                 schema=CONTRADICTION_SCHEMA, prompt_version=prompts.CONTRADICTION_VERSION)
            answer = session.ask(RULE_ID, request)
            if answer is None:
                continue
            answers, dropped = items(answer, "findings", ContradictionItem)
            session.dropped[RULE_ID] += dropped
            seen: set[tuple[str, str]] = set()
            for item in answers:
                line = refs.get(item.line_ref.strip())
                finding = _finding(ctx, session, line, item) if line else None
                if finding is None:
                    session.dropped[RULE_ID] += 1
                    continue
                key = (line.id, finding.id)
                if key not in seen:
                    seen.add(key)
                    yield finding


def _finding(ctx, session, line: Line, item: ContradictionItem):
    # Anti-hallucination: each quote must be in its own text, and the two must actually differ.
    if not quote_in(item.short_quote, line.short_text) or not quote_in(item.long_quote, line.long_text):
        return None
    short_value, long_value = normalize(item.short_quote), normalize(item.long_quote)
    if short_value == long_value or short_value in long_value:
        return None
    if _DIMENSION_PROPERTY.search(item.property):
        brief = {centimetres(match[1], match[2]) for match in _LENGTH.finditer(short_value)}
        detail = {centimetres(match[1], match[2]) for match in _LENGTH.finditer(long_value)}
        if not brief or not detail or brief & detail:
            return None
    # The long text also states the short-text value: probably two parts of one item, not a conflict.
    also_in_long = quote_in(item.short_quote, line.long_text)
    confidence = clamp_confidence(item.confidence) if not also_in_long else min(clamp_confidence(item.confidence), 0.3)
    message = (f"{line_label(line)}: {item.message.strip()} "
               f"Short text: \"{item.short_quote.strip()}\"; long text: \"{item.long_quote.strip()}\".")
    if also_in_long:
        message += " The long text also contains the short-text value, so both may be right."
    return ctx.finding(
        line=line, field="short_text", severity="info" if also_in_long else "warning",
        discriminator=re.sub(r"\W", "", long_value), message=message, origin="llm", model=session.model_id,
        evidence={"property": item.property.strip(), "short_quote": item.short_quote.strip(),
                  "long_quote": item.long_quote.strip(), "long_text_also_has_short_value": also_in_long,
                  "confidence": confidence, "prompt_version": prompts.CONTRADICTION_VERSION},
        suggested_fix=review_fix("Confirm the intended specification in the drawings or tender schedule, "
                                 "then align both descriptions or identify which component each value describes."),
    )
