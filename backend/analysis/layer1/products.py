"""Compare a named offered variant with an explicit requirement and cited product evidence."""

from collections import defaultdict
from dataclasses import dataclass
import re

from .. import adapter, units
from ..registry import rule
from .common import BIDDER_INPUT, OR_EQUIVALENT, review_fix, source_detail, text_of
from .standards import material_family, supported_pipe_scopes


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
_MINIMUM_SN = re.compile(r"\b(?:mindestens\s+SN\s*|SN\s*(?:>=|≥|mindestens)\s*)([1-9]\d*)\b(?!\s*[.,/-]\s*\d)", re.I)
_ALTERNATIVE = re.compile(r"\b(?:wahlweise|alternativ|oder)\b", re.I)
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


def drainage_variant_comparisons(snapshot):
    """Yield the per-position outcome for explicitly named products with a minimum SN."""
    declarations = _by_identity(snapshot.declarations)
    for line in snapshot.lines:
        text = text_of(line)
        if not _DRAINAGE.search(line.short_text or line.long_text or ""):
            continue
        required = {int(match[1]) for match in _MINIMUM_SN.finditer(text)}
        offers = _offers(line, snapshot.project.source_document.format)
        if len(required) != 1 or not offers:
            continue
        minimum = next(iter(required))
        if len(offers) != 1:
            yield line, minimum, None, [], "insufficient_evidence"
            continue
        key, variant = next(iter(offers.items()))
        evidence = declarations.get(key, [])
        values = {item.ring_stiffness_sn for item in evidence if item.ring_stiffness_sn is not None}
        if len(values) != 1:
            yield line, minimum, variant, evidence, "insufficient_evidence"
        elif next(iter(values)) < minimum:
            yield line, minimum, variant, evidence, "conflict"
        else:
            yield line, minimum, variant, evidence, "satisfied"


@rule("L1.PRODUCT.DRAINAGE_RING_STIFFNESS", layer=1, category="product", severity="warning",
      title="Offered pipe stiffness needs review",
      description="Compare an explicitly named offered pipe to the minimum SN specified on the position.")
def ring_stiffness(ctx):
    for line, minimum, variant, declarations, outcome in drainage_variant_comparisons(ctx.input):
        if outcome == "satisfied":
            continue
        name = variant.label() if variant else "the offered pipe"
        evidence = {"outcome": outcome, "required_minimum_sn": minimum,
                    "declarations": [item.model_dump() for item in declarations]}
        if variant:
            evidence.update(variant.evidence())
        if outcome == "conflict":
            observed = next(item.ring_stiffness_sn for item in declarations if item.ring_stiffness_sn is not None)
            evidence["declared_sn"] = observed
            message = f"The position requires at least SN {minimum}. The supplied evidence for {name} states SN {observed}."
            action = f"Request an offered variant with evidence of at least SN {minimum}, or obtain approval for a revised requirement."
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
    if property.unit or target_unit:
        return units.convert(value, units.normalize(property.unit), units.normalize(target_unit)) if value is not None else None
    return value if value is not None else " ".join(str(property.value).casefold().split()) or None


def declared_property_comparisons(snapshot):
    if not snapshot.product_requirements:
        return
    lines = defaultdict(list)
    for line in snapshot.lines:
        if line.code:
            lines[normalized_code(line.code)].append(line)
    declarations = _by_identity(snapshot.declarations)
    for requirement in snapshot.product_requirements:
        targets = lines[normalized_code(requirement.position_code)]
        if len(targets) != 1:
            yield None, requirement, None, [], None, "insufficient_evidence"
            continue
        line = targets[0]
        identities = _offers(line, snapshot.project.source_document.format)
        if len(identities) != 1:
            yield line, requirement, None, [], None, "insufficient_evidence"
            continue
        identity, offer = next(iter(identities.items()))
        items = declarations.get(identity, [])
        target_unit = requirement.required.unit
        expected = _value_in_unit(requirement.required, target_unit)
        values = {_value_in_unit(prop, target_unit) for item in items
                  if (prop := item.properties.get(requirement.property_name))}
        if None in values or expected is None or len(values) != 1:
            yield line, requirement, offer, items, None, "insufficient_evidence"
            continue
        actual = next(iter(values))
        if requirement.comparison == "equal":
            matches = actual == expected
        elif isinstance(actual, str) or isinstance(expected, str):
            yield line, requirement, offer, items, None, "insufficient_evidence"
            continue
        elif requirement.comparison == "at_least":
            matches = actual >= expected
        else:
            matches = actual <= expected
        yield line, requirement, offer, items, actual, "satisfied" if matches else "conflict"


@rule("L1.PRODUCT.DECLARED_PROPERTY", layer=1, category="product", severity="warning",
      title="Declared product property needs review",
      description="Compare an identified product variant with a typed, source-linked requirement.")
def declared_properties(ctx):
    for line, requirement, offer, items, actual, outcome in declared_property_comparisons(ctx.input):
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
        else:
            message = f"The available evidence cannot establish {name} for position {position} against the requirement {expected}."
            action = f"Confirm the position link and offered variant, then attach one governing declaration for {name} with comparable units."
        yield ctx.finding(
            line=line, field=offer.field if offer else ("long_text" if line else None),
            discriminator=f"{position}/{name}/{requirement.document}/{requirement.locator}/{outcome}",
            evidence={"outcome": outcome, "requirement": requirement.model_dump(mode="json"), "observed": actual,
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
