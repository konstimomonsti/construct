"""L3.REVIEW.L2_CONFIRM: re-read the texts behind each layer 2 "missing dependency" finding.

Layer 2 uses written quantities and narrowly attributed scope statements.
For a remaining layer 2 finding about missing or insufficient work, the model gets the trigger items,
any matched dependency items and the other items of the same section, and decides: included, excluded,
missing or unclear. This rule never edits the layer 2 finding. It emits its own finding that points at
it (`evidence.reviews_finding_id`), so the review UI can show both together:

- included / excluded -> info, "probably a false positive", with a quote verified in the cited item;
- missing             -> warning, "confirmed";
- unclear             -> nothing (the layer 2 finding stands on its own).
"""

from __future__ import annotations

from ...contracts import AnalysisInput, Finding, Line
from ...registry import rule
from .. import prompts
from ..common import batches, clip, current
from ..provider import LLMRequest
from ..schema import L2_CONFIRM_SCHEMA, L2Review, clamp_confidence, items, quote_in

RULE_ID = "L3.REVIEW.L2_CONFIRM"
REVIEWED_REASONS = {"missing", "quantity_shortfall"}
MAX_CONTEXT_LINES = 25  # trigger + dependency items + same-section neighbours per group
MAX_FINDINGS_PER_CALL = 8


def reviewable(finding: Finding) -> bool:
    return finding.layer == 2 and finding.evidence.get("reason") in REVIEWED_REASONS


def context_lines(analysis_input: AnalysisInput, finding: Finding) -> list[tuple[Line, str]]:
    """Items the model sees for a finding: triggers, matched dependencies, then section neighbours."""
    by_id = analysis_input.line_by_id()
    roles: dict[str, str] = {}
    for line_id in finding.evidence.get("trigger_line_ids") or []:
        roles.setdefault(line_id, "trigger")
    for line_id in finding.evidence.get("dependency_line_ids") or []:
        roles.setdefault(line_id, "dependency")
    for line_id in finding.related_line_ids:
        roles.setdefault(line_id, "trigger")
    for line_id in finding.evidence.get("unassigned_candidate_line_ids") or []:
        roles.setdefault(line_id, "context")
    anchors = [by_id[line_id] for line_id in roles if line_id in by_id]
    sections = {line.section_id for line in anchors}
    anchor_order = [line.sort_order for line in anchors] or [0]
    neighbours = sorted(
        (line for line in analysis_input.lines if line.section_id in sections and line.id not in roles),
        key=lambda line: min(abs(line.sort_order - order) for order in anchor_order),
    )
    for line in neighbours:
        if len(roles) >= MAX_CONTEXT_LINES:
            break
        roles[line.id] = "context"
    chosen = [(by_id[line_id], role) for line_id, role in roles.items() if line_id in by_id]
    return sorted(chosen, key=lambda pair: pair[0].sort_order)


@rule(RULE_ID, layer=3, category="dependency", severity="info", title="Layer 2 finding reviewed",
      description="Re-checks each layer 2 missing-dependency finding against the full texts: included in "
                  "another item, excluded (bauseits), or really missing. LLM check; quotes are verified.")
def l2_confirm(ctx):
    session = current()
    to_review = [finding for finding in ctx.prior_findings if reviewable(finding)]
    # Findings that share the same items are reviewed in one call (one trigger, several dependencies).
    groups: dict[tuple[str, ...], tuple[list[tuple[Line, str]], list[Finding]]] = {}
    for finding in to_review:
        lines = context_lines(ctx.input, finding)
        if not lines:
            continue
        key = tuple(line.id for line, _ in lines)
        groups.setdefault(key, (lines, []))[1].append(finding)

    sections = ctx.input.section_by_id()
    for lines, findings in groups.values():
        line_refs = {f"#{index}": line for index, (line, _) in enumerate(lines, start=1)}
        items_payload = [{"ref": ref, "role": role, "code": line.code, "short_text": line.short_text,
                          "long_text": clip(line.long_text), "quantity": _plain(line.quantity),
                          "unit": line.unit_raw or line.unit}
                         for (ref, line), (_, role) in zip(line_refs.items(), lines)]
        sized = [(finding, 1) for finding in findings]
        for chunk in batches(sized, MAX_FINDINGS_PER_CALL, MAX_FINDINGS_PER_CALL):
            finding_refs = {f"F{index}": finding for index, finding in enumerate(chunk, start=1)}
            findings_payload = [{"ref": ref, "requirement": finding.evidence.get("dependency") or finding.title,
                                 "required_for": finding.evidence.get("trade_category"),
                                 "check": finding.evidence.get("check_type"), "finding": finding.message}
                                for ref, finding in finding_refs.items()]
            request = LLMRequest(system=prompts.L2_CONFIRM_SYSTEM,
                                 prompt=prompts.l2_confirm_prompt(findings_payload, items_payload),
                                 schema=L2_CONFIRM_SCHEMA, prompt_version=prompts.L2_CONFIRM_VERSION)
            answer = session.ask(RULE_ID, request)
            if answer is None:
                continue
            reviews, dropped = items(answer, "reviews", L2Review)
            session.dropped[RULE_ID] += dropped
            answered: set[str] = set()
            for review in reviews:
                reviewed = finding_refs.get(review.finding_ref.strip())
                if reviewed is None or reviewed.id in answered:
                    session.dropped[RULE_ID] += 1
                    continue
                result = _finding(ctx, session, sections, reviewed, review, line_refs)
                if result is False:
                    session.dropped[RULE_ID] += 1
                    continue
                answered.add(reviewed.id)
                if result is not None:
                    yield result


def _finding(ctx, session, sections, reviewed: Finding, review: L2Review, line_refs: dict[str, Line]):
    """Finding for one review, None for "unclear", False when the answer fails validation."""
    if review.verdict == "unclear":
        return None
    dependency = reviewed.evidence.get("dependency") or reviewed.title
    evidence = {"reviews_finding_id": reviewed.id, "reviews_rule_id": reviewed.rule_id,
                "verdict": review.verdict, "reason": review.reason.strip(),
                "confidence": clamp_confidence(review.confidence), "prompt_version": prompts.L2_CONFIRM_VERSION}
    related = list(reviewed.related_line_ids)
    if review.verdict == "missing":
        title = f"Confirmed missing: {dependency.lower()}"
        message = f"Layer 2 reported missing {dependency.lower()}; the texts don't cover it. {review.reason.strip()}"
        severity = "warning"
    else:
        # Anti-hallucination: included/excluded must cite an item we sent, with a verbatim quote.
        line = line_refs.get(review.line_ref.strip())
        if line is None or not quote_in(review.quote, line.short_text, line.long_text):
            return False
        evidence.update({"quote": review.quote.strip(), "quote_line_id": line.id, "quote_line_code": line.code})
        related.append(line.id)
        where = f"{line.code or 'item'}: \"{review.quote.strip()}\""
        if review.verdict == "included":
            title = f"Probably included: {dependency.lower()}"
            message = (f"Layer 2 reported missing {dependency.lower()}, but it seems to be included in {where}. "
                       f"{review.reason.strip()}")
        else:
            title = f"Probably excluded from the contract: {dependency.lower()}"
            message = (f"Layer 2 reported missing {dependency.lower()}, but the text excludes it, {where}. "
                       f"{review.reason.strip()}")
        severity = "info"
    target = reviewed.target
    return ctx.finding(
        section=sections.get(target.section_id) if target.section_id else None, area_id=target.area_id,
        field=target.field, title=title, severity=severity, message=message, evidence=evidence,
        related_line_ids=list(dict.fromkeys(related)), discriminator=reviewed.id, origin="llm",
        model=session.model_id,
    )


def _plain(value) -> str | None:
    return None if value is None else format(value, "f")
