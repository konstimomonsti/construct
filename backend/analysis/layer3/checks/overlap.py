"""Review possible overlapping work when similar descriptions escape exact matching."""

from collections import Counter, defaultdict
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
import json
import re

from pydantic import BaseModel, Field

from ...contracts import Finding, Line
from ...layer1.common import review_fix
from ...layer1.consistency import _EXECUTION_PREFIX, _PRECEDING_SCOPE, _WORD, _overlap_identity, _overlap_words
from ...layer1.text_defects import refers_to_previous
from ...registry import rule
from ..common import batches, clip, current, l1_error_fields
from ..provider import LLMRequest
from ..schema import items, normalize, quote_in

RULE_ID = "L3.DUP.SEMANTIC"
VERSION = "l3-overlap-v1"
_TITLE_TYPES = (
    re.compile(r"\b(?:nieder|mittel|hoch|höchst)spannungskabel\b|\b(?:fernmelde|glasfaser|daten|steuer)kabel\b", re.I),
    re.compile(r"\b(?:foto|bestands|anlagen|revision|revisions|montage)[ -]dokumentation\b", re.I),
    re.compile(r"\basphalt(?:beton)?(?:trag|deck|binder)schicht\b", re.I),
)

_REDUCER_GEOMETRY = re.compile(r"\b(konzentrisch|exzentrisch)\w*\b", re.I)
SYSTEM = """Compare pairs of German tender positions for overlap in priced work.
Check the actual work, covered object, location, and any differences in method or deliverables.
Keep distinct cable types, locations, components, or services separate even when rates and wording resemble each other.
Report overlap only when both positions cover materially the same work. If methods differ in a way that changes scope,
or coverage is uncertain, leave the pair out. Do not infer equivalence from prices, quantities, or similar wording alone.
For each reported ref, copy a short verbatim phrase naming the work from each of the two supplied positions,
as first_quote and second_quote. Billing boilerplate does not count as a work phrase.
Return an empty findings array if no pair qualifies."""


class OverlapItem(BaseModel):
    ref: str
    first_quote: str = Field(min_length=3, max_length=240)
    second_quote: str = Field(min_length=3, max_length=240)


@dataclass(frozen=True)
class Position:
    line: Line
    brief: Counter[str]
    detail: Counter[str]


def _different_title_types(first: str, second: str) -> bool:
    return any(_disjoint_types(pattern, first, second) for pattern in _TITLE_TYPES)


def _disjoint_types(pattern: re.Pattern[str], first: str, second: str) -> bool:
    left = {normalize(term).replace("-", " ") for term in pattern.findall(first)}
    right = {normalize(term).replace("-", " ") for term in pattern.findall(second)}
    return bool(left and right and left.isdisjoint(right))


def candidates(lines: Iterable[Line], prior_findings: Iterable[Finding]) -> Iterator[tuple[Line, Line]]:
    """Return plausible pairs after scope, quantity and technical value checks."""
    blocked = l1_error_fields(prior_findings)
    already_flagged = {
        frozenset((finding.target.line_id, other))
        for finding in prior_findings
        if finding.rule_id in {"L1.CODE.DUPLICATE", "L1.DUP.SUSPECTED", "L1.DUP.NEAR_TEXT"}
        for other in finding.related_line_ids
    }
    groups = defaultdict(list)
    for line in sorted(lines, key=lambda item: item.sort_order):
        if (not line.code or not line.short_text or not line.long_text or not line.unit
                or line.quantity is None or line.quantity <= 0 or line.total_rule != "include"
                or _PRECEDING_SCOPE.search(line.short_text) or refers_to_previous(line)
                or blocked.get(line.id, set()) & {"code", "quantity", "unit", "short_text", "long_text"}):
            continue
        short = _EXECUTION_PREFIX.sub("", line.short_text)
        long = _EXECUTION_PREFIX.sub("", line.long_text)
        position = Position(line, Counter(_WORD.findall(short.casefold())), Counter(_WORD.findall(long.casefold())))
        if position.brief.total() < 3 or position.detail.total() < 7:
            continue
        key = (line.section_id, line.unit, line.quantity, line.pricing_basis,
               _overlap_identity(short)[1:], _overlap_identity(long)[1:])
        for first in groups[key]:
            other = first.line
            if (frozenset((line.id, other.id)) in already_flagged
                    or _different_title_types(line.short_text, other.short_text or "")
                    or _disjoint_types(_REDUCER_GEOMETRY, line.long_text, other.long_text or "")
                    or (normalize(line.short_text), normalize(line.long_text))
                    == (normalize(other.short_text), normalize(other.long_text))
                    or _overlap_words(first.brief, position.brief) < 0.66
                    or _overlap_words(first.detail, position.detail) < 0.55):
                continue
            yield other, line
        groups[key].append(position)


def _text(line: Line) -> list[str]:
    return [clip(line.short_text, 300) or "", clip(line.long_text, 1100) or ""]


def _request(payload: list[dict]) -> LLMRequest:
    properties = {"ref": {"type": "string", "enum": [pair["ref"] for pair in payload]},
                  "first_quote": {"type": "string"}, "second_quote": {"type": "string"}}
    schema = {"type": "object", "additionalProperties": False, "required": ["findings"],
              "properties": {"findings": {"type": "array", "maxItems": len(payload),
                                          "items": {"type": "object", "additionalProperties": False,
                                                    "required": list(properties), "properties": properties}}}}
    return LLMRequest(SYSTEM, json.dumps(payload, ensure_ascii=False), schema, VERSION)


def _work_quote(quote: str, text: list[str]) -> bool:
    words = _WORD.findall(normalize(quote))
    if len(words) < 2 or words[0] in {"abrechnung", "vergütung"}:
        return False
    nouns = [word for word in _WORD.findall(normalize(text[0])) if len(word) >= 5]
    return (any(term.startswith(word) or word.endswith(term) for term in nouns for word in words if len(word) >= 5)
            and quote_in(quote, *text))


@rule(RULE_ID, layer=3, category="duplicate", severity="warning",
      title="Potential overlap in priced work",
      description="Review similarly worded positions within a section against both source descriptions.")
def semantic_overlap(ctx):
    session = current()
    entries = [(pair, sum(len(field) for line in pair for field in _text(line)))
               for pair in candidates(ctx.input.lines, ctx.prior_findings)]
    for batch in batches(entries, session.max_batch_chars, min(session.max_batch_lines, 4)):
        refs = {f"F{index}": pair for index, pair in enumerate(batch, 1)}
        payload = {ref: {"ref": ref, "first": _text(first), "second": _text(second)}
                   for ref, (first, second) in refs.items()}
        answer = session.ask(RULE_ID, _request(list(payload.values())))
        if answer is None:
            continue
        if not isinstance(answer.get("findings"), list):
            session.errors.append(f"{RULE_ID}: the model did not return a findings list")
            continue
        reviews, dropped = items(answer, "findings", OverlapItem)
        session.dropped[RULE_ID] += dropped
        seen = set()
        for review in reviews:
            evidence = payload.get(review.ref)
            if (not evidence or review.ref in seen or not _work_quote(review.first_quote, evidence["first"])
                    or not _work_quote(review.second_quote, evidence["second"])):
                session.dropped[RULE_ID] += 1
                continue
            seen.add(review.ref)
            first, second = refs[review.ref]
            yield ctx.finding(line=second, field="long_text", related_line_ids=[first.id], discriminator=first.id,
                message=f"Positions {first.code} and {second.code} may cover the same work.",
                evidence={"related_position": first.code, "related_source_locator": first.source_locator,
                          "first_quote": review.first_quote, "second_quote": review.second_quote,
                          "quantity": second.quantity, "unit": second.unit, "prompt_version": VERSION},
                suggested_fix=review_fix("Compare both cited positions with the drawings and approved takeoff. "
                                         "Confirm their work boundaries before clarifying or removing any duplicated scope."),
                origin="llm", model=session.model_id)
