"""Cross-item scope audit of precast sections (spec Step 4): L3.SCOPE.REBAR_AMBIGUOUS,
L3.SCOPE.SHOP_DRAWINGS_OVERLAP and L3.SCOPE.EMBEDDED_UNALLOCATED.

One call per section, with the audit model (ANALYSIS_L3_AUDIT_MODEL), on the JSON of the items extracted
by `precast.py` (not the raw text). A section is only sent when the item types make at least one of the
problems possible, and every answer is checked in code against the same preconditions:

- REBAR_AMBIGUOUS:       the cited item is rebar whose purpose the text leaves open, and the section has
                         precast elements;
- SHOP_DRAWINGS_OVERLAP: the cited item is a shop-drawing item, and a precast item includes anchor design;
- EMBEDDED_UNALLOCATED:  the cited item is an embedded part assigned to no element.

The three rules share one audit per run (session memo); each emits only its own findings.
"""

from __future__ import annotations

from typing import Any

from ...contracts import Line
from ...registry import rule
from .. import prompts
from ..common import current
from ..provider import LLMRequest
from ..schema import SCOPE_SCHEMA, ScopeItem, clamp_confidence, items
from .precast import extracted

REBAR = "L3.SCOPE.REBAR_AMBIGUOUS"
SHOP_DRAWINGS = "L3.SCOPE.SHOP_DRAWINGS_OVERLAP"
EMBEDDED = "L3.SCOPE.EMBEDDED_UNALLOCATED"
AUDIT = "L3.SCOPE.AUDIT"  # budget/error label for the audit calls (not a rule)
MEMO_KEY = "scope_audit"
ELEMENTS = ("sandwich_plinth", "precast_element")
RULE_FOR_CHECK = {"REBAR_AMBIGUOUS": REBAR, "SHOP_DRAWINGS_OVERLAP": SHOP_DRAWINGS,
                  "EMBEDDED_UNALLOCATED": EMBEDDED}
CHANGE_ORDER = {REBAR, EMBEDDED}  # scope gaps that typically end in a Nachtrag

SCOPE_ACTIONS = {
    REBAR: "Confirm which package prices factory reinforcement and which prices on-site connection steel.",
    SHOP_DRAWINGS: "Confirm which package includes anchor design so the same work is priced once.",
    EMBEDDED: "Assign the parts to specific elements and confirm who supplies and installs them.",
}

Group = list[tuple[Line, dict[str, Any]]]


def possible(check: str, group: Group) -> bool:
    """Whether the section's items make the problem possible at all."""
    types = [data["item_type"] for _, data in group]
    if check == "REBAR_AMBIGUOUS":
        return any(t in ELEMENTS for t in types) and any(_open_rebar(data) for _, data in group)
    if check == "SHOP_DRAWINGS_OVERLAP":
        return "shop_drawings" in types and any(
            data["item_type"] in ELEMENTS and data["includes_anchor_engineering"] for _, data in group)
    return any(_unallocated(data) for _, data in group)


def anchor_ok(check: str, data: dict[str, Any]) -> bool:
    if check == "REBAR_AMBIGUOUS":
        return _open_rebar(data)
    if check == "SHOP_DRAWINGS_OVERLAP":
        return data["item_type"] == "shop_drawings"
    return _unallocated(data)


def audit(ctx) -> dict[str, list[tuple[Line, ScopeItem, list[Line]]]]:
    """rule id -> (anchor line, validated answer, related lines). Memoized per run."""
    session = current()
    if MEMO_KEY in session.memo:
        return session.memo[MEMO_KEY]
    groups: dict[str | None, Group] = {}
    for line, data in extracted(ctx):
        groups.setdefault(line.section_id, []).append((line, data))
    titles = {section.id: section.title for section in ctx.input.sections}
    to_send = [(section_id, group) for section_id, group in groups.items()
               if any(possible(check, group) for check in RULE_FOR_CHECK)]
    requests = [LLMRequest(system=prompts.SCOPE_SYSTEM,
                           prompt=prompts.scope_prompt(titles.get(section_id), [_payload(l, d) for l, d in group]),
                           schema=SCOPE_SCHEMA, prompt_version=prompts.SCOPE_VERSION)
                for section_id, group in to_send]
    result: dict[str, list[tuple[Line, ScopeItem, list[Line]]]] = {rule_id: [] for rule_id in RULE_FOR_CHECK.values()}
    for (_, group), answer in zip(to_send, session.ask_many(AUDIT, requests, audit=True)):
        if answer is None:
            continue
        answers, dropped = items(answer, "findings", ScopeItem)
        session.dropped[AUDIT] += dropped
        by_code = {line.code: (line, data) for line, data in group if line.code}
        seen: set[tuple[str, str]] = set()
        for item in answers:
            anchor = by_code.get(item.line_code.strip())
            key = (item.check, item.line_code.strip())
            if anchor is None or key in seen or not possible(item.check, group) \
                    or not anchor_ok(item.check, anchor[1]):
                session.dropped[AUDIT] += 1
                continue
            seen.add(key)
            related = [by_code[code.strip()][0] for code in item.related_codes
                       if code.strip() in by_code and code.strip() != anchor[0].code]
            result[RULE_FOR_CHECK[item.check]].append((anchor[0], item, related))
    session.memo[MEMO_KEY] = result
    return result


def _emit(ctx, rule_id: str):
    session = current()
    for line, item, related in audit(ctx)[rule_id]:
        question = item.bieterfrage_de.strip()
        if not question.startswith("Zu Pos."):
            question = f"Zu Pos. {line.code}: {question}"
        evidence = {"bieterfrage_de": question, "related_codes": [r.code for r in related],
                    "confidence": clamp_confidence(item.confidence), "prompt_version": prompts.SCOPE_VERSION}
        if rule_id in CHANGE_ORDER:
            evidence["change_order"] = True
        yield ctx.finding(line=line, related_line_ids=[r.id for r in related],
                          message=f"{item.message.strip()} {SCOPE_ACTIONS[rule_id]}",
                          evidence=evidence, origin="llm", model=session.model_for(audit=True))


@rule(REBAR, layer=3, category="scope", severity="warning", title="Rebar scope ambiguous",
      description="Rebar is tendered separately from the precast elements without saying whether it is the "
                  "elements' factory reinforcement or on-site connection steel (spec LLM_SCOPE_01). "
                  "Audit-model check on the extracted items.")
def rebar_ambiguous(ctx):
    yield from _emit(ctx, REBAR)


@rule(SHOP_DRAWINGS, layer=3, category="scope", severity="warning", title="Shop drawings overlap anchor design",
      description="A shop-drawing item overlaps with anchor design already included in the precast items "
                  "(spec LLM_SCOPE_02). Audit-model check on the extracted items.")
def shop_drawings_overlap(ctx):
    yield from _emit(ctx, SHOP_DRAWINGS)


@rule(EMBEDDED, layer=3, category="scope", severity="warning", title="Embedded parts not allocated",
      description="Embedded parts (Halfen rails, anchor channels) are not assigned to specific elements "
                  "(spec LLM_SCOPE_03). Audit-model check on the extracted items.")
def embedded_unallocated(ctx):
    yield from _emit(ctx, EMBEDDED)


def _open_rebar(data: dict[str, Any]) -> bool:
    return data["item_type"] == "rebar" and data["rebar_purpose"] in ("unspecified", "not_applicable")


def _unallocated(data: dict[str, Any]) -> bool:
    return data["item_type"] == "embedded_part" and not data["assigned_element_codes"]


def _payload(line: Line, data: dict[str, Any]) -> dict[str, Any]:
    """Compact item JSON for the audit: the line's own facts plus the non-empty extracted fields."""
    fields = {key: value for key, value in data.items()
              if value not in (None, False, [], "") and key not in ("oz", "has_redacted_or_unclear_text",
                                                                    "unclear_text_evidence")}
    if fields.get("rebar_purpose") == "not_applicable":
        fields.pop("rebar_purpose")
    if isinstance(fields.get("layers"), dict):
        fields["layers"] = {k: v for k, v in fields["layers"].items() if v is not None} or None
    return {"code": line.code, "short_text": line.short_text, **fields}
