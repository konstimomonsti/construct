"""Pure deterministic dependency rules: no database access and no input edits."""

from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal
import re
from typing import Literal

from ..contracts import (
    AddLine, AnalysisInput, Distribution, Finding, Fix, Line, NewLine, Target, finding_key,
)
from ..units import Dimension, dimension as shared_dimension
from .quantities import convert
from .schema import DependencySpec, RuleSpec, compile_regex, load_rules

ScopeMode = Literal["auto", "document", "trade", "section", "area"]


@dataclass(frozen=True)
class Entry:
    line: Line
    quantity: Decimal | None
    allocation_unreliable: bool = False


@dataclass
class Context:
    scope: str
    target: Target
    label: str
    entries: list[Entry]


def _text(line: Line) -> str:
    return " ".join(filter(None, [line.short_text, line.long_text, *line.tags]))


def _trigger_text(line: Line) -> str:
    """What a line *is*: its short text (long text only if there is none) plus classification tags.

    Long texts mention materials in passing ("Dichtmanschette aus EPDM", "Stützen aus Beton werden
    bauseits erstellt"), which must not make a pipe coupling a roof or a pipe removal a concrete job.
    """
    return " ".join(filter(None, [line.short_text or line.long_text, *line.tags]))


def _is_trigger(text: str, trigger: re.Pattern, exclude: re.Pattern | None) -> bool:
    return bool(trigger.search(text)) and not (exclude and exclude.search(text))


# PDF item flags meaning "not a firm part of the order": Bedarfsposition ohne/mit GB, Wahlposition.
# adapter.derive_pricing reads only the GAEB names (Provis, AltItem, ...) so far, which leaves these
# lines at total_rule "include" (IMPLEMENTATION_PLAN.md §0.2). Such a line must neither trigger a
# check nor count as covering a dependency.
_NOT_FIRM_FLAGS = ("unit_price_only", "provisional_included", "alternative_item")


def _active(line: Line) -> bool:
    if any(str(line.gaeb_flags.get(flag, "")).casefold() == "true" for flag in _NOT_FIRM_FLAGS):
        return False
    return (line.total_rule == "include" and line.alternative_for is None
            and (line.quantity is None or line.quantity > 0))


def _contexts(input: AnalysisInput, mode: ScopeMode) -> list[Context]:
    lines = [line for line in input.lines if _active(line)]
    if mode == "auto":
        mode = "area" if any(line.distributions for line in lines) else "document"
    if mode == "document":
        return [Context("bom", Target(), "Entire BoQ", [Entry(line, line.quantity) for line in lines])]
    if mode in ("trade", "section"):
        sections = {section.id: section for section in input.sections}
        groups: dict[str | None, list[Entry]] = defaultdict(list)
        for line in lines:
            key = line.section_id
            if mode == "trade":
                seen = set()
                while key in sections and sections[key].parent_id and key not in seen:
                    seen.add(key)
                    key = sections[key].parent_id
            groups[key].append(Entry(line, line.quantity))
        return [Context(
            "section" if key else "bom", Target(section_id=key),
            sections[key].title if key in sections else (key or "Unassigned trade/section"), entries,
        ) for key, entries in groups.items()]
    if mode != "area":
        raise ValueError(f"Unknown scope: {mode}")
    if not any(line.distributions for line in lines):
        return _contexts(input, "document")
    groups = defaultdict(list)
    unassigned = []
    for line in lines:
        if not line.distributions:
            unassigned.append(Entry(line, line.quantity))
            continue
        allocations: dict[str, list[Decimal | None]] = defaultdict(list)
        for distribution in line.distributions:
            allocations[distribution.area_id].append(distribution.quantity)
        quantities = [distribution.quantity for distribution in line.distributions]
        complete = all(qty is not None and qty >= 0 for qty in quantities)
        allocated = sum((qty for qty in quantities if qty is not None), Decimal(0))
        reliable = complete and line.quantity is not None and allocated <= line.quantity
        for area_id, values in allocations.items():
            quantity = (sum(values, Decimal(0))
                        if all(qty is not None and qty >= 0 for qty in values) else None)
            if quantity != 0:
                groups[area_id].append(Entry(line, quantity, not reliable))
        if reliable and allocated < line.quantity:
            unassigned.append(Entry(line, line.quantity - allocated))
        elif not reliable:
            # Keep uncertain residuals visible; never silently discard a line.
            unassigned.append(Entry(line, None, True))
    areas = {area.id: area for area in input.areas}
    contexts = [Context("area", Target(area_id=key), areas[key].name if key in areas else key, entries)
                for key, entries in groups.items()]
    if unassigned:
        contexts.append(Context("bom", Target(), "Unassigned quantities", unassigned))
    return contexts


def _blocked_lines(prior_findings: list[Finding]) -> set[str]:
    return {finding.target.line_id for finding in prior_findings
            if finding.layer == 1 and finding.severity == "error"
            and finding.target.line_id is not None
            and finding.target.field in {"quantity", "unit"}}


# Dimensions a quantity can be measured in. A matched line measured in another one of these is a
# different kind of item (insulation shells in pieces next to insulation in metres, stair treads in
# pieces next to tiles in m²) and is left out of the comparison. Lump sums, composite and unknown
# units may still cover the whole quantity, so they keep making the check "not assessable".
_MEASURED = {Dimension.COUNT, Dimension.LENGTH, Dimension.AREA, Dimension.VOLUME, Dimension.MASS,
             Dimension.TIME}


def _other_dimension(line_unit: str | None, unit: str) -> bool:
    line_dimension = shared_dimension(line_unit)
    return line_dimension in _MEASURED and line_dimension != shared_dimension(unit)


def _quantity(entries: list[Entry], unit: str, blocked: set[str]) -> tuple[Decimal, list[dict], list[dict]]:
    total = Decimal(0)
    problems = []
    skipped = []
    for entry in entries:
        reason = None
        if _other_dimension(entry.line.unit, unit):
            skipped.append({"line_id": entry.line.id, "unit": entry.line.unit})
            continue
        if entry.line.id in blocked:
            reason = "layer1_quantity_or_unit_error"
        elif entry.allocation_unreliable:
            reason = "incomplete_or_inconsistent_distribution"
        elif entry.quantity is None or entry.quantity <= 0:
            reason = "missing_or_non_positive_quantity"
        converted = None if reason else convert(entry.quantity, entry.line.unit, unit)
        if reason is None and converted is None:
            reason = "incompatible_or_unknown_unit"
        if reason:
            problems.append({"line_id": entry.line.id, "unit": entry.line.unit, "reason": reason})
        else:
            total += converted
    return total, problems, skipped


def finding_id(rule_id: str, target: Target) -> str:
    return finding_key(rule_id, target)


def _proposal(dep: DependencySpec, triggers: list[Entry], context: Context,
              quantity: Decimal | None, eligible: bool) -> Fix | None:
    if not eligible or not dep.suggested_text:
        return None
    first = triggers[0].line
    rationale = ("Heuristic complement inferred from BoQ text; confirm specification, scope, "
                 "and quantity before adding it to a new BOM version.")
    if quantity is None:
        # Presence checks can't infer an amount: the reviewer must enter it, otherwise the new line
        # would be flagged by L1.QTY.MISSING after it is applied.
        rationale += " The quantity cannot be derived: enter it before accepting."
    return Fix(
        confidence=0.55 if quantity is not None else 0.4,
        rationale=rationale,
        operations=[AddLine(
            section_id=first.section_id, after_line_id=first.id,
            line=NewLine(short_text=dep.suggested_text, quantity=quantity,
                         unit=dep.quantity_unit if quantity is not None else dep.suggested_unit),
            distributions=([Distribution(area_id=context.target.area_id, quantity=quantity)]
                           if context.target.area_id and quantity is not None else []),
        )],
    )


def _evaluate(input: AnalysisInput, rule: RuleSpec, dep: DependencySpec, triggers: list[Entry],
              matches: list[Entry], context: Context, tolerance: Decimal,
              blocked: set[str], unassigned_candidates: list[str]) -> Finding | None:
    target = context.target.model_copy(update={"field": "quantity" if dep.check_type == "QuantityMatch" else None})
    rule_id = f"{rule.rule_id}_NEEDS_{dep.key}"
    evidence = {
        "trade_category": rule.category, "context": context.label,
        "dependency": dep.name, "check_type": dep.check_type,
        "trigger_regex": dep.trigger_regex or rule.trigger_regex, "dependency_regex": dep.regex,
        "trigger_in": rule.trigger_in, "exclude_regex": dep.exclude_regex or rule.exclude_regex,
        "trigger_line_ids": list(dict.fromkeys(entry.line.id for entry in triggers)),
        "dependency_line_ids": list(dict.fromkeys(entry.line.id for entry in matches)),
        "unassigned_candidate_line_ids": unassigned_candidates,
        "trigger_items": [{"id": entry.line.id, "code": entry.line.code,
                           "short_text": entry.line.short_text} for entry in triggers],
    }
    trigger_unreliable = any(entry.line.id in blocked or entry.allocation_unreliable
                             for entry in triggers)
    severity = "warning"
    proposed_quantity = None
    if dep.check_type == "Boolean":
        if matches:
            if not all(entry.line.id in blocked or entry.allocation_unreliable for entry in matches):
                return None
            reason = "dependency_not_assessable"
            severity = "info"
            message = f"{dep.name} matches exist, but layer 1 errors or room allocations make them unreliable."
        else:
            reason = "missing"
            if trigger_unreliable or unassigned_candidates:
                severity = "info"
            message = f"No {dep.name.lower()} was found for {rule.category.lower()} in {context.label}."
        evidence["unreliable_trigger_line_ids"] = [entry.line.id for entry in triggers
                                                    if entry.line.id in blocked or entry.allocation_unreliable]
    else:
        trigger_qty, trigger_problems, trigger_skipped = _quantity(triggers, dep.quantity_unit, blocked)
        dependency_qty, dependency_problems, dependency_skipped = _quantity(matches, dep.quantity_unit, blocked)
        threshold = trigger_qty * (Decimal(1) - tolerance)
        evidence.update({
            "quantity_unit": dep.quantity_unit, "tolerance_pct": str(tolerance),
            "trigger_quantity": str(trigger_qty), "dependency_quantity": str(dependency_qty),
            "minimum_required_quantity": str(threshold),
            "shortfall_to_minimum": str(max(Decimal(0), threshold - dependency_qty)),
            "variance": str(dependency_qty - trigger_qty),
            "variance_pct": str((dependency_qty - trigger_qty) / trigger_qty * 100) if trigger_qty else None,
            "trigger_quantity_problems": trigger_problems,
            "dependency_quantity_problems": dependency_problems,
            "skipped_trigger_lines": trigger_skipped,
            "skipped_dependency_lines": dependency_skipped,
        })
        if not trigger_qty and not trigger_problems:
            return None  # every trigger is measured in another dimension: nothing to compare
        if trigger_problems or dependency_problems:
            reason = "quantity_not_assessable"
            severity = "info"
            message = (f"Cannot reliably compare {dep.name.lower()} quantities in {context.label}; "
                       "some quantities, units, or room allocations are unreliable.")
        elif dependency_qty >= threshold:
            return None
        else:
            # Matches in another dimension were skipped: they don't make the dependency present.
            reason = "missing" if len(dependency_skipped) == len(matches) else "quantity_shortfall"
            if unassigned_candidates:
                severity = "info"
            message = (f"{dep.name}: {dependency_qty} {dep.quantity_unit} found for "
                       f"{trigger_qty} {dep.quantity_unit} of {rule.category.lower()} in {context.label}; "
                       f"at least {threshold} {dep.quantity_unit} expected with {tolerance * 100}% tolerance.")
            # Propose the difference to full coverage, not just the tolerance boundary.
            proposed_quantity = trigger_qty - dependency_qty
    if unassigned_candidates:
        message += " Matching unassigned items may cover this area; confirm their allocation."
    evidence["reason"] = reason
    evidence["dependency_severity"] = dep.severity
    proposal_eligible = severity == "warning" and not trigger_unreliable
    if severity == "warning" and dep.severity == "info":
        severity = "info"
        message += (" This is often tendered in another package; ask whether it is included elsewhere "
                    "or provided by others.")
    elif severity == "warning":
        message += " Confirm this work is included in the reviewed package."
    title = (f"Quantity cannot be verified: {dep.name}" if reason.endswith("not_assessable") else
             f"{'Missing' if reason == 'missing' else 'Insufficient'} {dep.name.lower()}")
    related = list(dict.fromkeys([entry.line.id for entry in triggers + matches]))
    return Finding(
        id=finding_id(rule_id, target), layer=2, rule_id=rule_id,
        category="dependency", severity=severity, scope=context.scope, target=target,
        related_line_ids=related, title=title, message=message, evidence=evidence,
        suggested_fix=_proposal(dep, triggers, context, proposed_quantity, proposal_eligible),
    )


def run(input: AnalysisInput, prior_findings: list[Finding], *,
        rules: list[RuleSpec] | None = None, scope: ScopeMode = "auto",
        tolerance: Decimal = Decimal("0.10")) -> list[Finding]:
    """Return only layer 2 findings; the shared runner merges prior findings.

    The first two arguments implement the shared layer interface. Optional
    keyword arguments configure this standalone implementation.
    """
    tolerance = Decimal(str(tolerance))
    if not tolerance.is_finite() or not Decimal(0) <= tolerance < Decimal(1):
        raise ValueError("Tolerance must be a fraction >= 0 and < 1 (0.10 means 10%)")
    blocked = _blocked_lines(prior_findings)
    contexts = _contexts(input, scope)
    rules = load_rules() if rules is None else rules
    texts = {line.id: _text(line) for line in input.lines}
    short_texts = {line.id: _trigger_text(line) for line in input.lines}
    unassigned = [entry for context in contexts if context.scope == "bom" for entry in context.entries]
    findings = []
    for rule in rules:
        trigger_texts = short_texts if rule.trigger_in == "short_text" else texts
        trigger_pattern = compile_regex(rule.trigger_regex)
        exclude_pattern = compile_regex(rule.exclude_regex) if rule.exclude_regex else None
        dependency_patterns = [(dep, compile_regex(dep.regex),
                                compile_regex(dep.trigger_regex) if dep.trigger_regex else None,
                                compile_regex(dep.exclude_regex) if dep.exclude_regex else None)
                               for dep in rule.dependencies]
        for context in contexts:
            triggers = [entry for entry in context.entries
                        if _is_trigger(trigger_texts[entry.line.id], trigger_pattern, exclude_pattern)]
            if not triggers:
                continue
            for dep, pattern, condition, dep_exclude in dependency_patterns:
                relevant_triggers = [entry for entry in triggers
                                     if (condition is None or condition.search(trigger_texts[entry.line.id]))
                                     and not (dep_exclude and dep_exclude.search(trigger_texts[entry.line.id]))]
                if not relevant_triggers:
                    continue
                matches = [entry for entry in context.entries if pattern.search(texts[entry.line.id])]
                unassigned_candidates = (list(dict.fromkeys(entry.line.id for entry in unassigned
                                         if pattern.search(texts[entry.line.id])))
                                         if context.scope == "area" else [])
                finding = _evaluate(input, rule, dep, relevant_triggers, matches, context,
                                    dep.tolerance if dep.tolerance is not None else tolerance,
                                    blocked, unassigned_candidates)
                if finding:
                    findings.append(finding)
    return findings

