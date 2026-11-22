"""Extract tender relationships using bounded position context and the shared L3 session."""

import json
import re

from ...quantity_relationships import RELATION_MARKER, RULE_ID, Relationship, normalized, position_code, references, verify
from ...registry import rule
from .. import prompts
from ..common import batches, current, l1_error_fields
from ..provider import LLMRequest
from ..schema import items

RELATIONSHIP_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["relationships"],
    "properties": {"relationships": {"type": "array", "items": {
        "type": "object",
        "additionalProperties": False,
        "required": list(Relationship.model_fields),
        "properties": {key: {"type": ["string", "null"] if key in {"dependent_ref", "ratio", "qualifier"} else "string"}
                       for key in Relationship.model_fields},
    }}},
}

REASONS = {
    "assumption": "Confirm the assumed ratio against the tender specification.",
    "conflict": "The tender gives conflicting ratios for this scope.",
    "qualified_scope": "Confirm coverage, exclusions or conditional scope before pricing extra units.",
    "ambiguous_scope": "Confirm which position covers the requirement for this room, lot or section.",
    "missing_position": "There is no separate dependent position with a unit rate.",
    "missing_rate_position": "The dependent position needs a positive tender quantity and unit-rate pricing.",
    "incompatible_units": "The position units do not support a pieces-per-piece calculation.",
    "invalid_quantity": "Check the listed position quantities before pricing extra units.",
}


def _excerpt(text):
    if len(text) <= 1_400:
        return text
    # Preserve contiguous context around the first relationship even when it occurs deep in a long text.
    marker = RELATION_MARKER.search(text)
    start = max(0, marker.start() - 320) if marker else 0
    return text[start:start + 1_400]


@rule(RULE_ID, layer=3, category="quantity", severity="warning", title="Tender quantity relationship",
      description="Verify explicit count-per-count requirements and compare listed quantities within their scope.")
def quantity_relationships(ctx):
    session = current()
    all_lines = sorted(ctx.input.lines, key=lambda line: line.sort_order)
    sections = ctx.input.section_by_id()
    ordered = {line.id: index for index, line in enumerate(all_lines)}
    refs = {line.id: f"P{index}" for index, line in enumerate(all_lines, 1)}
    by_ref = {refs[line.id]: line for line in all_lines}
    by_code = {}
    for line in all_lines:
        by_code.setdefault(position_code(line.code), []).append(line)
    blocked = l1_error_fields(ctx.prior_findings)
    source_texts = {line.id: (line.short_text or "", line.long_text or "") for line in all_lines}
    anchors = [line for line in all_lines if any(RELATION_MARKER.search(text) for text in source_texts[line.id])]
    if not anchors:
        return

    def scope_label(line):
        labels = []
        section_id = line.section_id
        seen = set()
        while section_id in sections and section_id not in seen:
            seen.add(section_id)
            section = sections[section_id]
            labels.append(f"{section.code or section.id} {section.title or ''}".strip()[:160])
            section_id = section.parent_id
        return " / ".join(reversed(labels))[-320:]

    def encode(line, *, source):
        short, long = source_texts[line.id]
        return json.dumps({
            "ref": refs[line.id], "code": line.code, "section": scope_label(line), "source": source,
            "short_text": _excerpt(short) if source else short[:240],
            "long_text": _excerpt(long) if source else long[:240],
            "quantity": str(line.quantity) if line.quantity is not None else None,
            "unit": line.unit_raw or line.unit, "pricing_basis": line.pricing_basis, "total_rule": line.total_rule,
        }, ensure_ascii=False)

    entries = {line.id: encode(line, source=True) for line in anchors}
    context = {line.id: encode(line, source=False) for line in all_lines}
    char_limit = max(1, session.max_batch_chars - 160)
    requests, groups = [], []
    for group in batches([(line, len(entries[line.id]) + 2) for line in anchors],
                         max(1, char_limit // 2), max(1, session.max_batch_lines // 2)):
        source_ids = {line.id for line in group}
        records = dict((line.id, entries[line.id]) for line in group)
        mentioned = set().union(*(references(entries[line.id]) for line in group))
        explicit = {line.id for code in mentioned for line in by_code.get(code, ())} - source_ids
        for line_id in sorted(explicit, key=ordered.__getitem__):
            records[line_id] = context[line_id]
        used = sum(len(value) + 2 for value in records.values())
        if used > char_limit:
            session.planned += 1
            session.skipped[RULE_ID] += 1
            session.reasons.append(f"{RULE_ID}: source and referenced positions exceeded the batch size limit")
            continue
        group_sections = {line.section_id for line in group}
        words = set(re.findall(r"[^\W\d_]{4,}", " ".join(entries[line.id] for line in group).casefold()))
        siblings = sorted((line for line in all_lines if line.id not in records and line.section_id in group_sections),
                          key=lambda line: (-len(words & set(re.findall(r"[^\W\d_]{4,}", (line.short_text or "").casefold()))),
                                            min(abs(ordered[line.id] - ordered[source.id]) for source in group)))
        for line in siblings:
            entry = context[line.id]
            if len(records) >= session.max_batch_lines:
                break
            if used + len(entry) + 2 <= char_limit:
                records[line.id] = entry
                used += len(entry) + 2
        payload = "[" + ",\n".join(records.values()) + "]"
        requests.append(LLMRequest(system=prompts.RELATIONSHIP_SYSTEM, prompt=payload,
                                   schema=RELATIONSHIP_SCHEMA, prompt_version=prompts.RELATIONSHIP_VERSION))
        groups.append((source_ids, records.keys()))

    verified = {}
    for (source_ids, sent_ids), answer in zip(groups, session.ask_many(RULE_ID, requests)):
        if answer is None:
            continue
        proposals, dropped = items(answer, "relationships", Relationship)
        session.dropped[RULE_ID] += dropped
        for item in proposals:
            source, base, target = (by_ref.get(ref) for ref in (item.source_ref, item.base_ref, item.dependent_ref))
            if (not source or source.id not in source_ids or not base or base.id not in sent_ids
                    or (item.dependent_ref is not None and (not target or target.id not in sent_ids))
                    or not normalized(item.quote)
                    or not any(normalized(item.quote) in normalized(_excerpt(text)) for text in source_texts[source.id])):
                session.dropped[RULE_ID] += 1
                continue
            item = item.model_copy(update={"source_ref": source.id, "base_ref": base.id,
                                           "dependent_ref": target.id if target else None})
            checked = verify(ctx.input, item)
            if checked is None:
                session.dropped[RULE_ID] += 1
                continue
            verified[(source.id, base.id, item.dependent_ref, item.quote, item.ratio)] = (item, checked)

    emitted = set()
    for item, checked in verified.values():
        source, base, dependent = checked.source, checked.base, checked.dependent
        reason = checked.reason
        if dependent and any(other.dependent and other.dependent.id == dependent.id
                             and (other.base.id != base.id or other_item.ratio != item.ratio)
                             for other_item, other in verified.values()):
            reason = "conflict"
        if reason == "covered":
            continue
        if reason == "shortfall" and any(blocked.get(line.id, set()) & {"quantity", "unit"}
                                         for line in (base, dependent)):
            reason = "invalid_quantity"
        if reason == "shortfall":
            if dependent.id in emitted or any(
                finding.layer == 2 and finding.evidence.get("reason") == "quantity_shortfall"
                and finding.evidence.get("dependency_line_ids") == [dependent.id]
                for finding in ctx.prior_findings
            ):
                continue
            emitted.add(dependent.id)
        target = dependent or base
        related = list(dict.fromkeys(line.id for line in (source, base, dependent) if line and line.id != target.id))
        line_codes = " / ".join(dict.fromkeys(line.code or line.id for line in (source, base, dependent) if line))
        calculation = None
        if reason == "shortfall":
            base_qty, ratio, required, listed, extra = (
                format(number.normalize(), "f")
                for number in (base.quantity, item.ratio, checked.required, checked.listed, checked.extra)
            )
            calculation = (f"{base_qty} × {ratio} = {required} required, "
                           f"{listed} listed, +{extra} {dependent.unit_raw or dependent.unit}")
        yield ctx.finding(
            line=target, field="quantity", related_line_ids=related, origin="llm", model=session.model_id,
            severity="warning" if calculation else "info",
            title="Verified quantity shortfall" if calculation else "Verify quantity scope",
            message=f'{line_codes} · “{item.quote}” · {calculation or REASONS[reason]}',
            discriminator=f"{source.id}:{base.id}:{item.dependent_ref}:{item.ratio}:{reason}",
            evidence={"reason": reason, "relationship": item.model_dump(mode="json"),
                      "prompt_version": prompts.RELATIONSHIP_VERSION, "calculation": calculation,
                      "required_quantity": str(checked.required) if calculation else None,
                      "listed_quantity": str(checked.listed) if calculation else None,
                      "extra_quantity": str(checked.extra) if calculation else None,
                      "bieterfrage_de": (
                          f"Zu Pos. {line_codes}: Bitte bestätigen Sie den geforderten Umfang für "
                          f"„{item.dependent_item}“ und die zugehörige Abrechnungsposition."
                      )},
        )
