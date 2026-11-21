"""Values that are present but contradict each other: unit vs text, lump sums, structure, duplicates, texts."""

from collections import Counter, defaultdict
from decimal import Decimal
import re

from .. import units
from ..contracts import Fix, SetField
from ..registry import rule
from .common import (
    BILLING_UNIT, BIDDER_INPUT, OR_EQUIVALENT, THRESHOLDS, excerpt, label, phase_has_prices, review_fix, section_label,
    section_subtrees, text_of,
)


@rule("L1.UNIT.TEXT_MISMATCH", layer=1, category="unit", severity="warning", title="Unit contradicts the text",
      description="The description states how the item is measured ('Abrechnung nach m2') and it differs from the unit.")
def unit_text_mismatch(ctx):
    for line in ctx.input.lines:
        text = text_of(line)
        match = BILLING_UNIT.search(text)
        if not match or line.unit is None:
            continue
        stated = units.normalize(match.group(1))
        if stated == "lump_sum" and line.pricing_basis == "lump_sum":
            continue
        if stated == line.unit or units.dimension(stated) is units.Dimension.UNKNOWN:
            continue
        fix = Fix(operations=[SetField(line_id=line.id, field="unit", old_value=line.unit, new_value=stated)],
                  confidence=0.6, rationale=f"The text says {match.group(0)!r}.")
        yield ctx.finding(line=line, field="unit", suggested_fix=fix,
                          message=f"{label(line)} is measured in {line.unit_raw or line.unit}, but the text says "
                                  f"{match.group(0)!r}.",
                          evidence={"unit": line.unit, "stated_unit": stated, "excerpt": excerpt(text, match)})


@rule("L1.LUMP.INCONSISTENT", layer=1, category="unit", severity="warning", title="Inconsistent lump sum",
      description="A lump sum (psch) should have quantity 1, and a lump-sum flag should not carry a measured unit.")
def lump_inconsistent(ctx):
    for line in ctx.input.lines:
        if line.unit == "lump_sum" and line.quantity is not None and line.quantity != 1:
            yield ctx.finding(line=line, field="quantity", discriminator="quantity",
                              message=f"{label(line)} is a lump sum (psch) with quantity {line.quantity}.",
                              evidence={"quantity": line.quantity, "unit": line.unit},
                              suggested_fix=review_fix("Confirm whether the price covers one lump sum or several "
                                                       "measured items. For a single lump sum, use quantity 1 and "
                                                       "verify the price covers the full scope."))
        elif line.unit == "lump_sum" and line.quantity is None:
            fix = Fix(operations=[SetField(line_id=line.id, field="quantity", old_value=None, new_value=Decimal(1))],
                      confidence=0.8, rationale="Lump sums are quantity 1.")
            yield ctx.finding(line=line, field="quantity", discriminator="quantity", severity="info",
                              suggested_fix=fix, message=f"{label(line)} is a lump sum without quantity.")
        elif line.pricing_basis == "lump_sum" and units.dimension(line.unit) not in (
                units.Dimension.LUMP, units.Dimension.UNKNOWN, units.Dimension.COUNT):
            yield ctx.finding(line=line, field="unit", discriminator="unit",
                              message=f"{label(line)} is flagged as a lump sum but measured in "
                                      f"{line.unit_raw or line.unit} (quantity {line.quantity}).",
                              evidence={"unit": line.unit, "quantity": line.quantity},
                              suggested_fix=review_fix("Check whether the quoted amount is a lump sum or a unit rate. "
                                                       "Align the pricing basis, unit and quantity with the confirmed offer."))


_EFFORT_CLAUSE = re.compile(r"\bnach\s+(?:tatsächlichem\s+)?Aufwand\b", re.I)
_NEGATED_EFFORT = re.compile(r"\b(?:nicht|keine?\w*|ohne)\b[^.;\n]{0,32}\bnach\s+(?:tatsächlichem\s+)?Aufwand", re.I)
_EFFORT_CONTEXT = re.compile(r"\b(?:abrechn\w*|Abrechnung|vergüt\w*|ausführ\w*|zu bezahlen)\b", re.I)


@rule("L1.LUMP.OPEN_SCOPE", layer=1, category="pricing", severity="warning",
      title="Lump sum leaves the pricing basis open",
      description="The position is a lump sum and describes work based on actual effort.")
def open_lump_sum_scope(ctx):
    for line in ctx.input.lines:
        if line.pricing_basis != "lump_sum" and line.unit != "lump_sum":
            continue
        for field, text in (("short_text", line.short_text or ""), ("long_text", line.long_text or "")):
            clauses = re.split(r"[.;\n]", text)
            matches = [clause.strip() for clause in clauses
                       if _EFFORT_CLAUSE.search(clause) and not _NEGATED_EFFORT.search(clause)
                       and (field == "short_text" or _EFFORT_CONTEXT.search(clause))]
            if matches:
                yield ctx.finding(line=line, field=field,
                    message=f"{label(line)} gives a lump sum and describes work priced by effort. Confirm which basis applies.",
                    evidence={"pricing_basis": line.pricing_basis, "unit": line.unit, "pricing_clause": matches[0],
                              "bieterfrage_de": f"Zu Pos. {line.code}: Bitte grenzen Sie den Leistungsumfang der "
                                               "Pauschale ab und bestätigen Sie, welche Leistungen gegebenenfalls "
                                               "nach Aufwand abgerechnet werden."})
                break


@rule("L1.TEXT.BIDDER_INPUT", layer=1, category="text", severity="warning", title="Bidder field not filled in",
      description="Blanks the bidder must fill (product, type, values). Expected in a tender, an error in a bid or award.")
def bidder_input(ctx):
    priced = phase_has_prices(ctx.input)
    for line in ctx.input.lines:
        text = text_of(line)
        matches = list(BIDDER_INPUT.finditer(text))
        if not matches:
            continue
        if priced:
            message = (f"{label(line)} still has {len(matches)} empty bidder field(s), e.g. "
                       f"'{excerpt(text, matches[0])}'. The offered product or value is not specified.")
            severity = "warning"
        else:
            message = (f"{label(line)} asks the bidder to fill in {len(matches)} field(s), e.g. "
                       f"'{excerpt(text, matches[0])}'. These must be completed in the bid.")
            severity = "info"
        yield ctx.finding(line=line, field="long_text", severity=severity, message=message,
                          evidence={"blanks": len(matches), "excerpts": [excerpt(text, m) for m in matches[:3]]})


@rule("L1.TEXT.OR_EQUIVALENT", layer=1, category="text", severity="info", title="Reference product 'or equivalent'",
      description="A named product 'oder gleichwertig': the price should be checked against the reference product.")
def or_equivalent(ctx):
    for line in ctx.input.lines:
        text = text_of(line)
        match = OR_EQUIVALENT.search(text)
        if match:
            yield ctx.finding(line=line, field="long_text",
                              message=f"{label(line)} names a reference product 'or equivalent': "
                                      f"'{excerpt(text, match)}'. The bidder must state the offered product.",
                              evidence={"excerpt": excerpt(text, match)})


@rule("L1.CODE.OUTSIDE_SECTION", layer=1, category="structure", severity="warning",
      title="OZ code does not match its section", description="The OZ prefix should be the code of the parent section.")
def code_outside_section(ctx):
    sections = ctx.input.section_by_id()
    for line in ctx.input.lines:
        section = sections.get(line.section_id)
        if not section or not section.code_parts or not line.code:
            continue
        if line.code_parts[:len(section.code_parts)] != section.code_parts:
            yield ctx.finding(line=line, field="code", related_line_ids=[],
                              message=f"OZ {line.code} sits in section {section_label(section)}.",
                              evidence={"code": line.code, "section_code": section.code})


@rule("L1.STRUCT.ORPHAN_LINE", layer=1, category="structure", severity="warning", title="Item outside any section",
      description="The document has sections but this item could not be placed in one.")
def orphan_line(ctx):
    if not ctx.input.sections:
        return
    for line in ctx.input.lines:
        if line.section_id is None:
            yield ctx.finding(line=line, field="section",
                              message=f"{label(line)} is not inside any section, so it is missing from section subtotals.")


@rule("L1.STRUCT.EMPTY_SECTION", layer=1, category="structure", severity="info", title="Empty section",
      description="A section without items.")
def empty_section(ctx):
    subtrees = section_subtrees(ctx.input)
    used = {line.section_id for line in ctx.input.lines}
    for section in ctx.input.sections:
        if not subtrees[section.id] & used:
            yield ctx.finding(section=section, message=f"Section {section_label(section)} contains no items.")


@rule("L1.STRUCT.ORPHAN_ALTERNATIVE", layer=1, category="structure", severity="warning",
      title="Alternative item without base item", description="A Wahlposition must refer to a Grundposition.")
def orphan_alternative(ctx):
    for line in ctx.input.lines:
        is_alternative = line.gaeb_flags.get("position_type") == "A" or line.gaeb_flags.get("AltItem")
        if is_alternative and not line.alternative_for:
            yield ctx.finding(line=line, field="alternative_for",
                              message=f"{label(line)} is an alternative item but no base item precedes it.")


@rule("L1.STRUCT.PROVISIONAL_ITEM", layer=1, category="structure", severity="info", title="Optional item (Bedarfsposition)",
      description="Optional items are not in the total. VOB/A §7 (1) 4 generally disallows them in public tenders.")
def provisional_item(ctx):
    for line in ctx.input.lines:
        if line.gaeb_flags.get("Provis") or line.gaeb_flags.get("provisional_flag") == "E":
            yield ctx.finding(line=line, field="total_rule",
                              message=f"{label(line)} is an optional item and is not counted in the total.",
                              evidence={"total_rule": line.total_rule, "flags": line.gaeb_flags})


@rule("L1.STRUCT.UNIT_PRICE_ONLY_IN_TOTAL", layer=1, category="arithmetic", severity="error",
      title="Unit-price-only item has an amount", description="'Nur Einheitspreis' items must not carry a line amount.")
def unit_price_only_in_total(ctx):
    for line in ctx.input.lines:
        amount = line.source_amounts.line_amount if line.source_amounts else None
        if line.total_rule == "unit_price_only" and amount:
            yield ctx.finding(line=line, field="line_amount",
                              message=f"{label(line)} is unit-price-only but has a line amount of {amount}. "
                                      f"It must not be added to the total.",
                              evidence={"line_amount": amount})


_PRECEDING_SCOPE = re.compile(
    r"\b(?:für|zu)\s+(?:(?:den|die|das|dem)\s+)?vorbeschrieben\w*\s+([\w-]{4,})", re.I,
)


@rule("L1.DUP.SUSPECTED", layer=1, category="duplicate", severity="warning", title="Possible duplicate item",
      description="Same description and unit twice in the same section: possible double counting.")
def suspected_duplicate(ctx):
    groups = defaultdict(list)
    previous_by_section = {}
    base_work = {}
    for line in sorted(ctx.input.lines, key=lambda item: item.sort_order):
        previous = previous_by_section.get(line.section_id)
        previous_by_section[line.section_id] = line
        if not line.short_text:
            continue
        key = (line.section_id, line.short_text.casefold(), (line.long_text or "").casefold(), line.unit)
        groups[key].append(line)
        reference = _PRECEDING_SCOPE.search(line.short_text)
        if reference and previous and previous.code and previous.short_text:
            previous_text = text_of(previous).casefold()
            term = re.escape(reference[1].casefold())
            if re.search(rf"\b{term}\b", previous_text) and not _PRECEDING_SCOPE.search(previous_text):
                base_work[line.id] = previous_text

    for lines in groups.values():
        resolved = all(line.id in base_work for line in lines)
        first_by_scope = {}
        for line in lines:
            scope = base_work[line.id] if resolved else None
            first = first_by_scope.setdefault(scope, line)
            if line is first:
                continue
            yield ctx.finding(line=line, related_line_ids=[first.id],
                              message=f"{label(line)} has the same description and unit as {first.code}.",
                              evidence={"same_as": first.code, "quantities": [first.quantity, line.quantity]},
                              suggested_fix=review_fix("Check whether these positions duplicate the same work or "
                                                       "cover separate quantities. If work is counted twice, remove the "
                                                       "duplicate and reconcile the amount with the approved takeoff."))


_WORD = re.compile(r"\b[^\W\d_]+\b")
_NUMBER = re.compile(r"\d+(?:[.,/]\d+)*")
_SCOPE_QUALIFIER = re.compile(
    r"\b(?:links|rechts|oben|unten|innen|außen|unter|über|vor|nach|mit|ohne|nur|kein\w*|nicht|bauseits|Bestand)\b",
    re.I,
)
_EXECUTION_PREFIX = re.compile(r"^\s*Ausführung\s*:\s*", re.I)


def _overlap_identity(text: str) -> tuple:
    nouns = (word.casefold() for word in _WORD.findall(text) if word[0].isupper())
    return (tuple(sorted(nouns)), tuple(sorted(_NUMBER.findall(text))),
            tuple(sorted(word.casefold() for word in _SCOPE_QUALIFIER.findall(text))))


def _overlap_words(words: Counter, other: Counter) -> float:
    return 2 * (words & other).total() / (words.total() + other.total())


@rule("L1.DUP.NEAR_TEXT", layer=1, category="duplicate", severity="warning",
      title="Possible overlap between similarly worded positions",
      description="Within a section, closely worded positions with the same named work, numeric specifications, "
                  "scope qualifiers, quantity, unit and written unit price may overlap.")
def reworded_duplicate(ctx):
    candidates = defaultdict(dict)
    for line in sorted(ctx.input.lines, key=lambda item: item.sort_order):
        amounts = line.source_amounts
        if (not line.short_text or not line.long_text or not line.unit or not line.quantity or line.quantity <= 0
                or line.total_rule != "include" or not amounts or amounts.unit_price is None
                or _PRECEDING_SCOPE.search(line.short_text)):
            continue
        short = _EXECUTION_PREFIX.sub("", line.short_text)
        long = _EXECUTION_PREFIX.sub("", line.long_text)
        brief, detail = Counter(_WORD.findall(short.casefold())), Counter(_WORD.findall(long.casefold()))
        if brief.total() < 3 or detail.total() < 7:
            continue
        key = (line.section_id, line.unit, line.quantity, line.pricing_basis, amounts.unit_price,
               _overlap_identity(short), _overlap_identity(long))
        wording = (line.short_text.casefold(), line.long_text.casefold())
        candidates_in_scope = candidates[key]
        if wording in candidates_in_scope:
            continue
        for first, first_brief, first_detail in candidates_in_scope.values():
            short_overlap = _overlap_words(brief, first_brief)
            long_overlap = _overlap_words(detail, first_detail)
            min_detail_overlap = 0.8 if brief == first_brief else 0.85
            if short_overlap < 0.8 or long_overlap < min_detail_overlap:
                continue
            terms = sorted((set(brief) ^ set(first_brief)) | (set(detail) ^ set(first_detail)))
            yield ctx.finding(line=line, related_line_ids=[first.id],
                message=f"{label(line)} may overlap with {first.code}. Both positions use the same quantity, "
                        "billing unit and written rate.",
                evidence={"same_as": first.code, "quantity": line.quantity, "unit": line.unit,
                          "unit_price": amounts.unit_price, "short_overlap": round(short_overlap, 2),
                          "long_overlap": round(long_overlap, 2), "differing_terms": terms},
                suggested_fix=review_fix("Compare both descriptions and their takeoff references. Retain both "
                                         "positions if they cover distinct work. If they overlap, remove or "
                                         "clarify the duplicated scope and reconcile the amounts."))
            break
        candidates_in_scope[wording] = (line, brief, detail)


@rule("L1.DIST.SUM_MISMATCH", layer=1, category="arithmetic", severity="warning",
      title="Room quantities do not add up", description="The per-room split must equal the line quantity.")
def distribution_mismatch(ctx):
    for line in ctx.input.lines:
        if not line.distributions or line.quantity is None:
            continue
        if any(d.quantity is None for d in line.distributions):
            continue
        total = sum(d.quantity for d in line.distributions)
        if abs(total - line.quantity) > THRESHOLDS.distribution_tolerance:
            yield ctx.finding(line=line, field="quantity",
                              message=f"{label(line)}: rooms add up to {total}, the line says {line.quantity}.",
                              evidence={"quantity": line.quantity, "distributed": total})
