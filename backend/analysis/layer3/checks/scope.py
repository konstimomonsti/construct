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

import json
from typing import Any

from ...contracts import Line
from ...registry import rule
from .. import prompts
from ..common import current
from ..provider import LLMRequest, OllamaProvider
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

Group = list[tuple[Line, dict[str, Any]]]
_LOCAL_VERSION = "l3-scope-local-v1"
_LOCAL_SYSTEM = """Review the listed candidate issues against extracted items of a German precast bill.
An unassigned rebar position beside precast elements warrants REBAR_AMBIGUOUS.
Shop drawings overlap when a precast element already supplies anchor design.
An embedded part without an assigned element warrants EMBEDDED_UNALLOCATED.
Return only the ref of each supported candidate in findings. Return an empty array if there are none."""
_LOCAL_WORDING = {
    "REBAR_AMBIGUOUS": ("A separate rebar item leaves factory reinforcement and site connection scope unclear.",
                        "Handelt es sich um die Bewehrung der Fertigteile oder um Anschlussbewehrung auf der Baustelle?"),
    "SHOP_DRAWINGS_OVERLAP": ("The shop drawings may overlap with anchor design included in the precast elements.",
                              "In welcher Position ist die Ankerplanung zu kalkulieren?"),
    "EMBEDDED_UNALLOCATED": ("The embedded part has no stated element assignment.",
                             "Welchen Fertigteilelementen ist das Einbauteil zugeordnet?"),
}



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
    local = isinstance(session.audit_provider or session.provider, OllamaProvider)
    to_send = [(section_id, group, _local_candidates(group) if local else {}) for section_id, group in groups.items()
               if any(possible(check, group) for check in RULE_FOR_CHECK)]
    if local:
        to_send = [batch for batch in to_send if batch[2]]
    requests = [
        _local_request(group, choices) if local else
        LLMRequest(system=prompts.SCOPE_SYSTEM,
                   prompt=prompts.scope_prompt(titles.get(section_id), [_payload(line, data) for line, data in group]),
                   schema=SCOPE_SCHEMA, prompt_version=prompts.SCOPE_VERSION)
        for section_id, group, choices in to_send
    ]
    result: dict[str, list[tuple[Line, ScopeItem, list[Line]]]] = {rule_id: [] for rule_id in RULE_FOR_CHECK.values()}
    for (_, group, choices), answer in zip(to_send, session.ask_many(AUDIT, requests, audit=True)):
        if answer is None:
            continue
        answers, dropped = _local_answers(answer, group, choices) if local else items(answer, "findings", ScopeItem)
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


def _local_candidates(group: Group) -> dict[str, tuple[str, str]]:
    pairs = [(check, line.code) for check in RULE_FOR_CHECK if possible(check, group)
             for line, data in group if line.code and anchor_ok(check, data)]
    return {f"F{index}": pair for index, pair in enumerate(pairs, start=1)}


def _local_request(group: Group, choices: dict[str, tuple[str, str]]) -> LLMRequest:
    schema = {"type": "object", "additionalProperties": False, "required": ["findings"],
              "properties": {"findings": {"type": "array", "maxItems": len(choices),
                                          "items": {"type": "string", "enum": list(choices)}}}}
    data = {"items": [_payload(line, item) for line, item in group],
            "candidates": [{"ref": ref, "check": check, "line_code": code} for ref, (check, code) in choices.items()]}
    return LLMRequest(_LOCAL_SYSTEM, "Review these candidates.\n\n" + json.dumps(data, ensure_ascii=False),
                      schema, _LOCAL_VERSION)


def _local_answers(answer: dict, group: Group, choices: dict[str, tuple[str, str]]) -> tuple[list[ScopeItem], int]:
    refs = answer.get("findings")
    if not isinstance(refs, list):
        return [], 1
    accepted = []
    for ref in refs:
        if not isinstance(ref, str) or ref not in choices:
            continue
        check, code = choices[ref]
        related = [line.code for line, data in group if line.code and data["item_type"] in ELEMENTS
                   and (check != "SHOP_DRAWINGS_OVERLAP" or data["includes_anchor_engineering"])]
        message, question = _LOCAL_WORDING[check]
        accepted.append(ScopeItem(check=check, line_code=code, related_codes=related, message=message,
                                  bieterfrage_de=f"Zu Pos. {code}: {question}", confidence=0.6))
    return accepted, len(refs) - len(accepted)


def _emit(ctx, rule_id: str):
    session = current()
    local = isinstance(session.audit_provider or session.provider, OllamaProvider)
    for line, item, related in audit(ctx)[rule_id]:
        question = item.bieterfrage_de.strip()
        if not question.startswith("Zu Pos."):
            question = f"Zu Pos. {line.code}: {question}"
        evidence = {"bieterfrage_de": question, "related_codes": [r.code for r in related],
                    "confidence": clamp_confidence(item.confidence), "prompt_version": _LOCAL_VERSION if local else prompts.SCOPE_VERSION}
        if rule_id in CHANGE_ORDER:
            evidence["change_order"] = True
        yield ctx.finding(line=line, related_line_ids=[r.id for r in related], message=item.message.strip(),
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
    fields = ("item_type", "element_code", "rebar_purpose", "includes_anchor_engineering", "assigned_element_codes")
    return {"code": line.code, "short_text": line.short_text,
            **{key: data[key] for key in fields if data[key] not in (None, False, [], "", "not_applicable")}}
