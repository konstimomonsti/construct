"""L3.REVIEW.L2_CONFIRM: re-read the texts behind each layer 2 "missing dependency" finding.

Layer 2 uses written quantities and narrowly attributed scope statements.
For a remaining layer 2 finding about missing or insufficient work, the model gets the trigger items,
any matched dependency items and the other items of the same section, and decides: included, excluded,
missing or unclear. This rule never edits the layer 2 finding. It emits its own finding that points at
it (`evidence.reviews_finding_id`), so the review UI can show both together:

- included / excluded -> advisory review with a source quote and a separate quantity check;
- missing             -> warning about the gap in the reviewed text;
- unclear             -> no additional finding.
"""

from __future__ import annotations

import re

from ...adapter import to_decimal
from ...contracts import AnalysisInput, Finding, Line
from ...layer1.common import review_fix, source_detail
from ...layer2.engine import _active
from ...registry import rule
from ...units import convert
from .. import prompts
from ..common import batches, clip, current
from ..provider import LLMRequest
from ..schema import L2_CONFIRM_SCHEMA, L2Review, clamp_confidence, items, normalize

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
        refs_by_id = {line.id: ref for ref, line in line_refs.items()}
        items_payload = [{"ref": ref, "role": role, "code": line.code, "short_text": line.short_text,
                          "long_text": clip(source_detail(line, ctx.input.project.source_document.format)),
                          "quantity": _plain(line.quantity), "unit": line.unit_raw or line.unit,
                          "firm_item": _active(line)}
                         for (ref, line), (_, role) in zip(line_refs.items(), lines)]
        sized = [(finding, 1) for finding in findings]
        for chunk in batches(sized, MAX_FINDINGS_PER_CALL, MAX_FINDINGS_PER_CALL):
            finding_refs = {f"F{index}": finding for index, finding in enumerate(chunk, start=1)}
            findings_payload = [{"ref": ref, "requirement": finding.evidence.get("dependency") or finding.title,
                                 "required_for": finding.evidence.get("trade_category"),
                                 "check": finding.evidence.get("check_type"), "finding": finding.message,
                                 "quantity_unit": finding.evidence.get("quantity_unit"),
                                 "minimum_shortfall": finding.evidence.get("shortfall_to_minimum"),
                                 "scope": finding.scope,
                                 "trigger_refs": [refs_by_id[id_] for id_ in finding.evidence.get("trigger_line_ids", [])
                                                  if id_ in refs_by_id],
                                 "counted_refs": [refs_by_id[id_] for id_ in finding.evidence.get("dependency_line_ids", [])
                                                  if id_ in refs_by_id]}
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
    locator = None
    if review.verdict == "missing":
        title = f"No coverage found for {dependency.lower()}"
        message = f"The reviewed text leaves the reported gap in {dependency.lower()} open. {review.reason.strip()}"
        severity = "warning"
        fix = review_fix("Check the remaining package documents and resolve the original dependency finding using "
                         "the confirmed scope and quantities.")
    else:
        line = line_refs.get(review.line_ref.strip())
        field = _quote_field(line, review.quote, ctx.input.project.source_document.format) if line else None
        if not field:
            return False
        evidence.update({"quote": review.quote.strip(), "quote_line_id": line.id, "quote_line_code": line.code,
                         "quote_field": field, "review_status": "advisory"})
        related.append(line.id)
        locator = line.source_locator or None
        where = f'position {line.code} (“{review.quote.strip()}”)' if line.code else f'“{review.quote.strip()}”'
        if review.verdict == "included":
            title = f"Review possible coverage for {dependency.lower()}"
            message = f"Check whether the wording in {where} covers the open {dependency.lower()} work."
            quantity_check = _quantity_check(line, reviewed, ctx.input)
            if quantity_check:
                evidence["quantity_check"] = quantity_check
            fix = review_fix("Confirm the quoted work covers the same dependency and scope. Reconcile the uncovered "
                             "quantity against the drawings or takeoff before accepting this review.")
        else:
            title = f"Review possible scope exclusion for {dependency.lower()}"
            message = f"Check whether the wording in {where} assigns the open {dependency.lower()} work elsewhere."
            fix = review_fix("Confirm that the exclusion applies to the triggering positions and their quantities. "
                             "Record which party or package covers the work before accepting this review.")
        severity = "info"
    target = reviewed.target
    return ctx.finding(
        section=sections.get(target.section_id) if target.section_id else None, area_id=target.area_id,
        field=target.field, title=title, severity=severity, message=message, evidence=evidence,
        related_line_ids=list(dict.fromkeys(related)), discriminator=reviewed.id, origin="llm",
        model=session.model_id, source_locator=locator, suggested_fix=fix,
    )


def _quote_field(line: Line, quote: str, source_format: str | None) -> str | None:
    needle = normalize(quote).strip(" .,;:\"'„“”")
    if not re.search(r"\w", needle):
        return None
    pattern = re.compile(rf"(?<!\w){re.escape(needle)}(?!\w)")
    for field, text in (("short_text", line.short_text), ("long_text", clip(source_detail(line, source_format)))):
        if pattern.search(normalize(text)):
            return field
    return None


def _quantity_check(line: Line, finding: Finding, analysis_input: AnalysisInput) -> dict | None:
    evidence = finding.evidence
    if evidence.get("check_type") != "QuantityMatch":
        return None
    unit = evidence.get("quantity_unit")
    needed = to_decimal(evidence.get("shortfall_to_minimum"))
    result = {"unit": unit, "minimum_shortfall": _plain(needed)}
    if line.id in evidence.get("dependency_line_ids", []):
        return {**result, "state": "already_counted"}
    if line.id in evidence.get("trigger_line_ids", []):
        return {**result, "state": "bundled_quantity_unknown"}
    if not _active(line):
        return {**result, "state": "not_a_firm_item"}
    lines = analysis_input.line_by_id()
    triggers = {lines[id].section_id for id in evidence.get("trigger_line_ids", []) if id in lines}
    if finding.target.area_id or line.distributions or triggers != {line.section_id}:
        return {**result, "state": "scope_unverified"}
    quantity = convert(line.quantity, line.unit, unit) if line.quantity is not None and unit else None
    if quantity is None or quantity <= 0:
        return {**result, "state": "quantity_unverified"}
    return {**result, "quantity": _plain(quantity),
            "state": "quantity_below_shortfall" if needed is not None and quantity < needed else "quantity_candidate"}


def _plain(value) -> str | None:
    return None if value is None else format(value, "f")
