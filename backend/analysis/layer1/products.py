"""Compare a named offered variant with an explicit requirement and cited product evidence."""

from collections import defaultdict
from dataclasses import dataclass
from decimal import DecimalException, Inexact, localcontext
import re

from .. import adapter, units
from ..contracts import ProductProperty, ProductRequirement
from ..registry import rule
from .common import BIDDER_INPUT, OR_EQUIVALENT, review_fix, source_detail, text_of
from .standards import MATERIAL, material_family, supported_pipe_scopes


_PAIR = (
    r"(?:Hersteller|Manufacturer)[ \t]*:[ \t]*(?P<manufacturer>[^:;\r\n]+?)[ \t]*[;\r\n]+[ \t]*"
    r"(?:Artikelnummer|SKU|(?:Artikel|Art\.)-Nr\.?)[ \t]*:[ \t]*(?P<code>[\w./-]+)[ \t]*(?=[;\r\n]|$)"
)
# The GAEB importer renders several detail paragraphs as one line.
_FIELD_START = r"(?:^|(?<=[.;]))[ \t]*"
_PRODUCT = re.compile(rf"{_FIELD_START}{_PAIR}", re.I | re.M)
_OFFER_LABEL = rf"{_FIELD_START}(?:Angebotenes[ \t]+Fabrikat|Offered[ \t]+product)[ \t]*:"
_OFFERED = re.compile(rf"{_OFFER_LABEL}[ \t]*(?:\r?\n)?[ \t]*{_PAIR}", re.I | re.M)
_OFFER_FIELD = re.compile(_OFFER_LABEL, re.I | re.M)
_PLANNED = re.compile(
    rf"{_FIELD_START}(?:Fabrikat[ \t]+der[ \t]+Planung|Planungsfabrikat|Referenzfabrikat|Leitfabrikat|Reference[ \t]+product)[ \t]*:",
    re.I | re.M,
)
_DRAINAGE = re.compile(r"\b(?:Abwasser|Kanal(?:grund)?)[ -]?rohr\w*\b", re.I)
_MINIMUM_SN = re.compile(
    r"(?<!\w)(?:(?:mindestens|>=|≥)\s*SN\s*|SN\s*(?:>=|≥|mindestens)\s*)([1-9]\d{0,8})\b"
    r"(?!\s*[.,/–—-]\s*\d)", re.I,
)
_ALTERNATIVE = re.compile(r"\b(?:wahlweise|alternativ|oder)\b", re.I)
_SN_PROPERTY = "ring_stiffness_sn"
_SN_SUBJECT = re.compile(rf"^(?:(?:{MATERIAL})[ -]+)?{_DRAINAGE.pattern}", re.I)
_SN_CLAUSE = re.compile(r"(?<=[.!?;])\s+|\n")
_SN_QUALIFIER = re.compile(r"\b(?:falls|sofern|wenn|gegebenenfalls|optional|bei Bedarf|für|oder|wahlweise|alternativ|Formstücke?|Muffen?|Bögen)\b", re.I)
_OFFER_UNDECIDED = re.compile(rf"[\s,;.]*(?:{OR_EQUIVALENT.pattern})", re.I)


def normalized_code(code):
    return tuple(part.lstrip("0") or "0" for part in code.strip(". ").split("."))


def _identity(manufacturer, code):
    return " ".join(manufacturer.casefold().split()), code.strip()


@dataclass(frozen=True)
class Offer:
    manufacturer: str
    code: str
    quote: str
    field: str

    def identity(self):
        return _identity(self.manufacturer, self.code)

    def evidence(self):
        return {"variant": (self.manufacturer, self.code), "offer_quote": self.quote, "offer_field": self.field}

    def label(self):
        return f"{self.manufacturer} {self.code}"


def _offers(line, source_format):
    """Attribute a labelled offer before considering any unqualified manufacturer/SKU pair."""
    fields = (("long_text", source_detail(line, source_format)), ("short_text", line.short_text))
    text = "\n".join(value for _, value in fields if value)
    if _ALTERNATIVE.search(OR_EQUIVALENT.sub("", text)):
        return {}
    offer_count = sum(1 for _ in _OFFER_FIELD.finditer(text))
    if offer_count:
        matches = [(field, match) for field, value in fields for match in _OFFERED.finditer(value or "")]
        if len(matches) != offer_count or any(_OFFER_UNDECIDED.match(match.string, match.end()) for _, match in matches):
            return {}
    elif OR_EQUIVALENT.search(text) or _PLANNED.search(text):
        return {}
    else:
        matches = [(field, match) for field, value in fields for match in _PRODUCT.finditer(value or "")]
    offers = {}
    for field, match in matches:
        manufacturer, code = match["manufacturer"].strip(), match["code"]
        if BIDDER_INPUT.search(match[0]) or not all(any(char.isalnum() for char in value)
                                                    for value in (manufacturer, code)):
            continue
        offer = Offer(manufacturer, code, match[0].strip(), field)
        offers.setdefault(offer.identity(), offer)
    return offers


def _by_identity(declarations):
    grouped = defaultdict(list)
    for item in declarations:
        grouped[_identity(item.manufacturer, item.product_code)].append(item)
    return grouped


@dataclass(frozen=True)
class WrittenStiffness:
    requirement: ProductRequirement
    field: str
    quote: str


def _written_stiffness(snapshot):
    source = snapshot.project.source_document
    written = {}
    for line in snapshot.lines:
        if not _DRAINAGE.search(line.short_text or line.long_text or ""):
            continue
        if _ALTERNATIVE.search(OR_EQUIVALENT.sub("", text_of(line))):
            continue
        matches = {}
        for field, text in (("short_text", line.short_text), ("long_text", source_detail(line, source.format))):
            for clause in _SN_CLAUSE.split(text or ""):
                for match in _MINIMUM_SN.finditer(clause):
                    lead = clause[:match.start()].strip(" ,:")
                    if _SN_QUALIFIER.search(clause[match.end():]) or _SN_QUALIFIER.search(lead):
                        continue
                    if lead and not (re.fullmatch("Ringsteifigkeit", lead, re.I) or _SN_SUBJECT.match(lead)):
                        continue
                    matches.setdefault(int(match[1]), (field, match[0]))
        if len(matches) == 1:
            value, (field, quote) = next(iter(matches.items()))
            location = "Heading" if field == "short_text" else "Description"
            requirement = ProductRequirement(
                position_code=(line.code or "(uncoded position)")[:100], property_name=_SN_PROPERTY,
                comparison="at_least", required=ProductProperty(value=str(value)),
                document=(source.filename or "Original tender")[:240], locator=f"{location} of position {line.code or 'shown'}"[:240],
            )
            written[line.id] = WrittenStiffness(requirement, field, quote)
    return written


def _sn_unit(unit):
    return unit is None or unit.strip().casefold() in {"", "sn"}


def _declared_sn_values(declarations):
    values = {item.ring_stiffness_sn for item in declarations if item.ring_stiffness_sn is not None}
    for item in declarations:
        if (property := item.properties.get(_SN_PROPERTY)) is not None:
            value = adapter.parse_number(property.value)
            values.add(value if value is not None and value > 0 and _sn_unit(property.unit) else None)
    return values


def drainage_variant_comparisons(snapshot, written, conflicts):
    """Compare explicitly named products against a written and uncontested minimum SN."""
    declarations = _by_identity(snapshot.declarations)
    for line in snapshot.lines:
        source = written.get(line.id)
        if source is None or (line.id, _SN_PROPERTY) in conflicts:
            continue
        offers = _offers(line, snapshot.project.source_document.format)
        if not offers:
            continue
        minimum = int(source.requirement.required.value)
        if len(offers) != 1:
            yield line, minimum, None, [], "insufficient_evidence"
            continue
        key, variant = next(iter(offers.items()))
        evidence = declarations.get(key, [])
        values = _declared_sn_values(evidence)
        if len(values) != 1 or None in values:
            yield line, minimum, variant, evidence, "insufficient_evidence"
        elif next(iter(values)) < minimum:
            yield line, minimum, variant, evidence, "conflict"
        else:
            yield line, minimum, variant, evidence, "satisfied"


@rule("L1.PRODUCT.DRAINAGE_RING_STIFFNESS", layer=1, category="product", severity="warning",
      title="Offered pipe stiffness needs review",
      description="Compare an explicitly named offered pipe to the minimum SN specified on the position.")
def ring_stiffness(ctx):
    written = _written_stiffness(ctx.input)
    conflicts = _incompatible_requirements(_requirement_positions(ctx.input), written)
    for line, minimum, variant, declarations, outcome in drainage_variant_comparisons(ctx.input, written, conflicts):
        if outcome == "satisfied":
            continue
        name = variant.label() if variant else "the offered pipe"
        source = written[line.id]
        evidence = {"outcome": outcome, "required_minimum_sn": minimum,
                    "requirement_quote": source.quote, "requirement_field": source.field,
                    "declarations": [item.model_dump() for item in declarations]}
        if variant:
            evidence.update(variant.evidence())
        if outcome == "conflict":
            observed = next(iter(_declared_sn_values(declarations)))
            evidence["declared_sn"] = observed
            message = f"The position requires at least SN {minimum}. The supplied evidence for {name} states SN {observed}."
            action = f"Request an offered variant that meets the cited limits, including the minimum of SN {minimum}, or obtain approval for a revised requirement."
        else:
            message = f"The position requires at least SN {minimum}. The evidence for {name} does not establish one declared SN value."
            action = "Confirm the exact manufacturer and product code, then attach the governing declaration and its SN value."
        yield ctx.finding(
            line=line, field=variant.field if variant else None, discriminator=outcome, message=message, evidence=evidence,
            severity="warning" if outcome == "conflict" else "info",
            suggested_fix=review_fix(action),
        )


def _value_in_unit(property, target_unit):
    value = adapter.parse_number(property.value)
    source, target = units.normalize(property.unit), units.normalize(target_unit)
    if source or target:
        return value if source == target or value is None else units.convert(value, source, target)
    return value if value is not None else " ".join(str(property.value).casefold().split()) or None


def _requirement_positions(snapshot):
    if not snapshot.product_requirements:
        return
    lines = defaultdict(list)
    for line in snapshot.lines:
        if line.code:
            lines[normalized_code(line.code)].append(line)
    for requirement in snapshot.product_requirements:
        candidates = lines[normalized_code(requirement.position_code)]
        locator = requirement.position_locator.model_dump(exclude_none=True) if requirement.position_locator else {}
        matches = [line for line in candidates if all(line.source_locator.get(key) == value
                                                       for key, value in locator.items())]
        yield requirement, candidates, matches


def _requirement_bound(requirement):
    unit = units.normalize(requirement.required.unit)
    if requirement.property_name == _SN_PROPERTY and _sn_unit(unit):
        value = adapter.parse_number(requirement.required.value)
        return (("exact", None), value) if value is not None and value > 0 else (None, None)
    value = _value_in_unit(requirement.required, unit)
    if value is None:
        return None, None
    if isinstance(value, str):
        return ("text", None), value
    factor = units.FACTORS.get(unit)
    if factor is None or unit == "set":
        return ("exact", unit), value
    # Multiplication to the base unit keeps inclusive bounds exact and avoids division rounding.
    with localcontext() as context:
        context.prec = max(context.prec, len(value.as_tuple().digits) + len(factor.as_tuple().digits))
        context.traps[Inexact] = True
        try:
            return ("base", units.dimension(unit)), value * factor
        except DecimalException:
            return ("exact", unit), value


def _incompatible_pair(requirements):
    bounds = {}
    exact_text = None
    for requirement in requirements:
        basis, value = _requirement_bound(requirement)
        if basis is None:
            continue
        comparison = requirement.comparison
        if isinstance(value, str):
            if comparison != "equal":
                continue
            if exact_text and value != exact_text[0]:
                return exact_text[1], requirement
            exact_text = value, requirement
            continue
        lower, upper = bounds.get(basis, (None, None))
        if comparison != "at_most" and (lower is None or value > lower[0]):
            lower = value, requirement
        if comparison != "at_least" and (upper is None or value < upper[0]):
            upper = value, requirement
        if lower and upper and lower[0] > upper[0]:
            return lower[1], upper[1]
        bounds[basis] = lower, upper
    return None


def _incompatible_requirements(positions, written):
    groups = defaultdict(list)
    for requirement, _, matches in positions:
        if len(matches) == 1:
            groups[matches[0].id, requirement.property_name].append(requirement)
    for line_id, source in written.items():
        groups[line_id, _SN_PROPERTY].append(source.requirement)
    return {key: pair for key, requirements in groups.items()
            if len(requirements) > 1 and (pair := _incompatible_pair(requirements))}


def _constraint_text(requirement):
    op = {"equal": "exactly", "at_least": "at least", "at_most": "at most"}[requirement.comparison]
    if requirement.property_name == _SN_PROPERTY and _sn_unit(requirement.required.unit):
        return f"{op} SN {requirement.required.value}"
    return f"{op} {requirement.required.value} {requirement.required.unit or ''}".strip()


@rule("L1.PRODUCT.REQUIREMENT_CONFLICT", layer=1, category="product", severity="warning",
      title="Source requirements disagree",
      description="Find incompatible requirements for the same property on one resolved position.")
def conflicting_product_requirements(ctx):
    lines = ctx.input.line_by_id()
    written = _written_stiffness(ctx.input)
    conflicts = _incompatible_requirements(_requirement_positions(ctx.input), written)
    for (line_id, property_name), pair in conflicts.items():
        first, second = pair
        source = written.get(line_id)
        citations = []
        for requirement in pair:
            citation = requirement.model_dump(mode="json")
            if source and requirement is source.requirement:
                citation.update(quote=source.quote, field=source.field)
            citations.append(citation)
        name = "ring stiffness" if property_name == _SN_PROPERTY else property_name
        yield ctx.finding(
            line=lines[line_id], discriminator=property_name,
            message=f"The requirements for {name} specify {_constraint_text(first)} and "
                    f"{_constraint_text(second)} for the same position.",
            evidence={"outcome": "requirement_conflict", "property_name": property_name,
                      "requirements": citations},
            suggested_fix=review_fix("Ask the specification owner which cited requirement governs. "
                                     "Align the source documents before comparing or selecting a product."),
        )


def _compare_property(line, requirement, source_format, declarations):
    offers = _offers(line, source_format)
    if len(offers) != 1:
        return None, [], None, "insufficient_evidence"
    identity, offer = next(iter(offers.items()))
    items = declarations.get(identity, [])
    target_unit = requirement.required.unit
    expected = _value_in_unit(requirement.required, target_unit)
    if requirement.property_name == _SN_PROPERTY and _sn_unit(target_unit):
        expected = adapter.parse_number(requirement.required.value)
        if expected is not None and expected <= 0:
            expected = None
        values = _declared_sn_values(items)
    else:
        values = {_value_in_unit(prop, target_unit) for item in items
                  if (prop := item.properties.get(requirement.property_name))}
    if None in values or expected is None or len(values) != 1:
        return offer, items, None, "insufficient_evidence"
    actual = next(iter(values))
    if requirement.comparison == "equal":
        matches = actual == expected
    elif isinstance(actual, str) or isinstance(expected, str):
        return offer, items, None, "insufficient_evidence"
    elif requirement.comparison == "at_least":
        matches = actual >= expected
    else:
        matches = actual <= expected
    return offer, items, actual, "satisfied" if matches else "conflict"


@rule("L1.PRODUCT.DECLARED_PROPERTY", layer=1, category="product", severity="warning",
      title="Declared product property needs review",
      description="Compare an identified product variant with a typed, source-linked requirement.")
def declared_properties(ctx):
    declarations = _by_identity(ctx.input.declarations)
    positions = list(_requirement_positions(ctx.input))
    conflicts = _incompatible_requirements(positions, _written_stiffness(ctx.input))
    for requirement, codes, matches in positions:
        line = matches[0] if len(matches) == 1 else None
        reason, candidates = None, []
        if line:
            if (line.id, requirement.property_name) in conflicts:
                continue
            offer, items, actual, outcome = _compare_property(line, requirement, ctx.input.project.source_document.format,
                                                               declarations)
        else:
            offer, items, actual, outcome = None, [], None, "insufficient_evidence"
            candidates = matches or codes
            reason = "position_ambiguous" if matches else "position_locator_mismatch" if codes else "position_missing"
        if outcome == "satisfied":
            continue
        position = requirement.position_code
        name = requirement.property_name
        unit = requirement.required.unit or ""
        expected = f"{requirement.required.value} {unit}".strip()
        operator = {"equal": "requires", "at_least": "requires at least", "at_most": "allows at most"}[requirement.comparison]
        if outcome == "conflict":
            observed = f"{actual} {unit}".strip()
            message = f"Position {position} {operator} {expected} for {name}. The offered variant declares {observed}."
            action = f"Confirm the requirement and request a variant with matching {name} evidence."
        elif reason == "position_ambiguous":
            message = f"Position {position} identifies {len(candidates)} source rows. The requirement for {name} needs an exact position link."
            action = "Specify the source locator that identifies the intended row, such as the worksheet and row."
        elif reason == "position_locator_mismatch":
            message = f"The source locator for position {position} does not match any row with that position code."
            action = "Check the requirement against the current source and correct its position code or locator."
        elif reason == "position_missing":
            message = f"The source has no position {position} for the requirement for {name}."
            action = "Confirm the requirement belongs to this bill and update its position code."
        else:
            message = f"The available evidence cannot establish {name} for position {position} against the requirement {expected}."
            action = f"Confirm the position link and offered variant, then attach one governing declaration for {name} with comparable units."
        detail = requirement.model_dump(mode="json")
        discriminator = f"{position}/{name}/{requirement.document}/{requirement.locator}/{outcome}"
        # Keep the existing finding ID for unqualified links. Distinguish individually qualified requirements.
        if locator := detail.get("position_locator"):
            discriminator += f"/{sorted(locator.items())}"
        example_candidates = candidates[:20]
        yield ctx.finding(
            line=line, field=offer.field if offer else ("long_text" if line else None),
            discriminator=discriminator, related_line_ids=[candidate.id for candidate in example_candidates],
            evidence={"outcome": outcome, "reason": reason, "requirement": detail, "observed": actual,
                      "position_candidate_count": len(candidates),
                      "position_candidates": [{"line_code": candidate.code, "locator": candidate.source_locator}
                                              for candidate in example_candidates],
                      "declarations": [item.model_dump(mode="json") for item in items],
                      **(offer.evidence() if offer else {})},
            message=message, suggested_fix=review_fix(action),
            severity="warning" if outcome == "conflict" else "info",
        )


@rule("L1.PRODUCT.DIN_MATERIAL", layer=1, category="product", severity="warning",
      title="Offered pipe material needs verification",
      description="Compare the exact offered variant's declared material with the cited drainage standard's published scope.")
def declared_pipe_material(ctx):
    declarations = _by_identity(ctx.input.declarations)
    seen = set()
    for line, field, clause, standard, basis in supported_pipe_scopes(ctx.input):
        key = (line.id, clause["number"])
        if key in seen:
            continue
        seen.add(key)
        identities = _offers(line, ctx.input.project.source_document.format)
        if len(identities) != 1:
            continue
        identity, variant = next(iter(identities.items()))
        items = declarations.get(identity, [])
        materials = [material_family(prop.value) if not prop.unit else None for item in items
                     if (prop := item.properties.get("material"))]
        values = set(materials)
        actual = next(iter(values)) if len(values) == 1 else None
        expected, edition, url = standard
        if actual == expected:
            continue
        identifier = f"DIN EN {clause['number']}"
        evidence = {**variant.evidence(), "declared_material": actual, "scope_material": expected,
                    "specification": " ".join(clause[0].split()), "edition_basis": basis,
                    "din_standard": {"identifier": identifier, "edition": edition, "url": url},
                    "declarations": [item.model_dump(mode="json") for item in items]}
        if actual is None:
            evidence["outcome"] = "insufficient_evidence"
            message = f"The declaration does not establish a material for {variant.label()} under {identifier}."
            action = "Confirm the offered manufacturer and SKU, then attach a declaration that establishes the material."
        else:
            evidence["outcome"] = "conflict"
            message = f"The offered variant declares {actual}. The cited {identifier}:{edition} covers {expected} drainage pipes."
            action = f"Verify the cited standard and request a {expected} variant with corresponding declaration evidence."
        yield ctx.finding(line=line, field=field, discriminator=f"{identifier}/{evidence['outcome']}",
                          severity="warning" if actual else "info",
                          message=message, evidence=evidence, suggested_fix=review_fix(action))
