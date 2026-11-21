"""Conservative extraction and compatibility rules for the pipe pilot."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict, dataclass, field
from decimal import Decimal
from hashlib import sha256
import json
import re
import unicodedata

from analysis import units

VERSION = "pipe-v1"
PIPE = re.compile(
    r"\b(?:(?:pe[ -]?(?:hd|100|80)|hdpe|pp|pvc[ -]?u?|edelstahl|stahl|guss|kupfer)[ -]?)?"
    r"(?:druckrohr|abwasserrohr|rohrleitung|rohr|pipe)s?(?:e|en)?\b", re.I,
)
CONDUIT = re.compile(r"\b(?:kabelschutzrohr|elektroinstallationsrohr|leerrohr|conduit)s?(?:e|en)?\b", re.I)
VALVE = re.compile(r"\b(?:[a-zäöü]*ventil(?:e|en)?|kugelhahn|absperrschieber|valves?)\b", re.I)
FAMILIES = {"Pipes": PIPE, "Cable conduits": CONDUIT, "Valves and controls": VALVE}
PIPE_FAMILIES = {"Pipes", "Cable conduits"}
MATERIALS = {
    "PE-HD": r"pe[ -]?hd|hdpe|pe[ -]?(?:100|80)",
    "PVC-U": r"pvc[ -]?u",
    "PVC": r"pvc(?![ -]?u)",
    "PP": r"pp",
    "stainless steel": r"edelstahl|stainless steel",
    "steel": r"stahl|(?<!stainless )steel",
    "copper": r"kupfer|copper",
    "cast iron": r"guss|cast iron",
}
NUMBER = r"\d+(?:[.,]\d+)?"
DIMENSIONS = {
    "outside_mm": rf"(?:\b(?:da|od|außendurchmesser)\s*[:=]?|[ø⌀])\s*({NUMBER})(?:\s*mm)?",
    "wall_mm": rf"\b(?:wandstärke|wall(?: thickness)?)\s*[:=]?\s*({NUMBER})(?:\s*mm)?",
    "dn": rf"\bdn\s*({NUMBER})\b",
    "sdr": rf"\bsdr\s*({NUMBER})\b",
    "pn": rf"\bpn\s*({NUMBER})\b",
    "sn": rf"\bsn\s*({NUMBER})\b",
    "piece_length_mm": rf"\b(?:stücklänge|baulänge|lieferlänge|piece length)\s*[:=]?\s*({NUMBER})\s*(mm|cm|m)\b",
    "pack_size": r"\b(?:pack(?: size)?|packung(?:sgroße|sgröße)?)\s*[:=]?\s*(\d+)\b",
}
SIZE_PAIR = re.compile(rf"(?<![\w.,])({NUMBER})\s*[x×]\s*({NUMBER})\s*(mm|cm)\b", re.I)
ELEMENT_QUANTITY = re.compile(rf"\b(?:menge|qty|quantity)\s*[:=]\s*({NUMBER})\s*(km|cm|mm|m|ea|stück|stk|pcs)\b", re.I)
REFERENCE = re.compile(
    r"\b(?:wie\s+(?:(?:zu)?vor(?:her)?\b|(?:pos(?:ition)?\.?)\s*)|same as (?:above\b|(?:item|position)\s*))"
    r"(?:\s*[,:\s]*\s*(?:pos(?:ition)?\.?\s*)?(\d+(?:\.\d+)*))?", re.I,
)
SUPPLY = re.compile(r"\b(?:liefern|lieferung|lieferleistung|supply|supplied|provide)\b", re.I)
INSTALL = re.compile(r"\b(?:einbau\w*|montag\w*|montier\w*|verleg\w*|install\w*|legen)\b", re.I)
BY_OTHERS = re.compile(
    r"\b(?:bauseits|beigestellt|ohne lieferung|provided by others|client[- ]supplied|supply by others)\b", re.I,
)
ACTIVITY = re.compile(
    r"\b(?:abbruch|abbauen|ausbauen|demont\w*|entsorg\w*|rückbau|reinigen|spülen|druckprüf\w*|"
    r"dichtheitsprüf\w*|testing|remov\w*|existing|bestehend\w*)\b", re.I,
)
INCLUDED = re.compile(r"\b(?:inkl(?:usive)?\.?|einschließlich|including|included)\b", re.I)
SEPARATE = re.compile(r"\b(?:separat(?:e(?:ly)?)? (?:gemessen|measured|vergütet)|gesondert vergütet)\b", re.I)
PAIR = re.compile(r"\b(?:paar\w*|paired|doppel(?:[- ]?(?:rohr|strang)|(?=[- ](?:leer|kabelschutz)rohr))|twin)\b"
                  r"|vor\s*-\s*und\s*rücklauf", re.I)
SPLIT = re.compile(r";|\n|\s+(?:und|and|inkl\.?|inklusive|einschließlich|including)\s+", re.I)
SKU = re.compile(r"\b(?:sku|artikel(?:nummer|[- ]?nr\.?)?)\s*[:#]?\s*([a-z0-9][a-z0-9._/-]*)", re.I)
SUPPLIER = re.compile(r"\b(?:supplier|lieferant|hersteller)\s*:\s*([^\n;,]+?)"
                      r"(?=\s+\b(?:sku|artikel)\b|[\n;,]|$)", re.I)


def canonical(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).casefold()
    return " ".join(re.findall(r"[\w]+(?:[.,]\d+)?", text))


def digest(value) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return sha256(encoded).hexdigest()


def number(text: str) -> str:
    return format(Decimal(text.replace(",", ".")).normalize(), "f")


def millimetres(value: str, unit: str) -> str:
    converted = units.convert(Decimal(number(value)), unit.lower(), "mm")
    return number(str(converted))


def attributes(text: str, category: str) -> dict:
    # Keep explicit unknowns and flag multiple values rather than choosing one.
    matched = {
        "material": [material for material, pattern in MATERIALS.items()
                     if re.search(rf"\b(?:{pattern})(?=\b|[- ]?rohr)", text, re.I)],
        "grade": re.findall(r"\b(pe[ -]?(?:100(?:[ -]?rc)?|80)|1\.\d{4}|s\d{3}[a-z]{0,3}|p\d{3}[a-z]{0,3})\b",
                            text, re.I),
    }
    matched["grade"] = [canonical(value).replace(" ", "") for value in matched["grade"]]
    for key, pattern in DIMENSIONS.items():
        values = re.findall(pattern, text, re.I)
        if key == "piece_length_mm":
            matched[key] = [millimetres(value, unit) for value, unit in values]
        else:
            matched[key] = [number(value) for value in values]
    if category != "Valves and controls":
        for outside, wall, unit in SIZE_PAIR.findall(text):
            matched["outside_mm"].append(millimetres(outside, unit))
            matched["wall_mm"].append(millimetres(wall, unit))
    if PAIR.search(text):
        matched["basis"] = ["paired"]
    result = {}
    for key, values in matched.items():
        distinct = sorted(set(values))
        result[key] = distinct if len(distinct) > 1 else next(iter(distinct), None)
    result.setdefault("basis", None)
    return result


@dataclass(frozen=True)
class SourceLine:
    id: str
    code: str | None
    section_id: str | None
    text: str
    quantity: Decimal | None
    unit: str | None
    raw_unit: str | None
    total_rule: str
    alternative_for: str | None
    pricing_basis: str
    locator: dict
    section_notes: list[dict] = field(default_factory=list)
    source_role: str | None = None
    companion_key: str | None = None
    duplicate: bool = False
    source_id: str | None = None
    reference_ids: tuple[str, ...] = ()
    headline: str | None = None
    raw_quantity: str | None = None


@dataclass(frozen=True)
class Candidate:
    name: str
    category: str
    attributes: dict
    source: dict
    context: dict
    scope: str
    selection: str
    quantity: str | None
    unit: str | None
    quantity_basis: str
    derivation: str
    sku: str | None = None
    supplier: str | None = None
    issues: tuple[str, ...] = ()
    local_identity_text: str = ""

    @property
    def specification(self) -> dict:
        complete = (
            self.category in PIPE_FAMILIES and self.attributes["material"]
            and (self.attributes["dn"] or (self.attributes["outside_mm"] and self.attributes["wall_mm"]))
        )
        # Bare technical descriptions can be reused across equivalent English/German wording.
        # Additional qualifiers remain identity-bearing, as does incomplete wording.
        residual = ELEMENT_QUANTITY.sub(" ", "\n".join(filter(None, (self.name, self.local_identity_text))))
        return {"version": VERSION, "category": self.category, "attributes": self.attributes,
                "description": description_key(self.category, residual) if complete else canonical(residual),
                "sku": self.sku, "supplier": self.supplier,
                "unit_basis": "length" if units.dimension(self.unit) == units.Dimension.LENGTH else self.unit,
                "issues": list(self.issues)}

    @property
    def fingerprint(self) -> str:
        return digest(self.specification)

    def record(self) -> dict:
        return {**asdict(self), "issues": list(self.issues), "fingerprint": self.fingerprint,
                "specification": self.specification}


def extract(lines: list[SourceLine], products=()) -> list[tuple[str, int, Candidate]]:
    by_code = defaultdict(list)
    by_source_id = defaultdict(list)
    previous = {}
    last = {}
    for line in lines:
        if line.code:
            by_code[code_key(line.code)].append(line)
        if line.source_id:
            by_source_id[line.locator.get("document_id"), line.source_id].append(line)
        key = (line.section_id, line.locator.get("document_id"))
        previous[line.id] = last.get(key)
        last[key] = line

    def references(start: SourceLine) -> tuple[list[SourceLine], list[str]]:
        path = [start]
        seen = {start.id}
        while True:
            current = path[-1]
            matches = list(REFERENCE.finditer(current.text))
            if not current.reference_ids and not matches:
                break
            explicit = {match[1] for match in matches if match[1]}
            if len(explicit) > 1:
                return path[1:], ["conflicting position references"]
            if explicit:
                targets = by_code[code_key(next(iter(explicit)))]
                same_doc = [line for line in targets if line.locator.get("document_id") ==
                            current.locator.get("document_id")]
                if same_doc:
                    targets = same_doc
                if len(targets) != 1:
                    return path[1:], ["missing or ambiguous position reference"]
                target = targets[0]
            elif not current.reference_ids:
                target = previous[current.id]
            else:
                target = None
            if current.reference_ids:
                doc = current.locator.get("document_id")
                targets = [by_source_id[doc, key] for key in current.reference_ids]
                if any(len(items) != 1 for items in targets):
                    return path[1:], ["missing or ambiguous GAEB item reference"]
                if len({items[0].id for items in targets}) != 1 or (explicit and target.id != targets[0][0].id):
                    return path[1:], ["conflicting position references"]
                target = targets[0][0]
            if target is None or target.id in seen:
                return path[1:], ["cyclic position reference" if target else "missing preceding position"]
            seen.add(target.id)
            path.append(target)
        return path[1:], []

    results = []
    for line in lines:
        inherited, issues = references(line)
        local = REFERENCE.sub("", line.text)
        identity_text = local
        local_families = set(families(local))
        parent_text = ""
        if inherited:
            parent_text = REFERENCE.sub("", inherited[-1].text)
            if not local_families:
                identity_text = parent_text
            elif set(families(parent_text)) != local_families:
                issues.append("local product family conflicts with referenced position")
        segments = split_products(identity_text)
        headline_families = families(inherited[-1].headline or "") if inherited and not local_families else (
            families(line.headline or "")
        )
        if not segments and not issues:
            name = matching_name(identity_text)
            sku = SKU.search(identity_text)
            supplier = SUPPLIER.search(identity_text)
            categories = {product.category for product in products if product.category in PIPE_FAMILIES and (
                name in (canonical(product.name), *product.aliases)
                or (sku and supplier and sku[1].casefold() == (product.sku or "").casefold()
                    and canonical(supplier[1]) == canonical(product.supplier or ""))
            )}
            segments = [(category, identity_text.strip(), False) for category in sorted(categories)]
        if len(segments) > 1 and inherited:
            issues.append("reference spans multiple product elements")
        if not segments and issues:
            segments = [("Unclassified", line.text, False)]
        for slot, (category, segment, included) in enumerate(segments):
            if slot == 0 and len(segments) == 1 and not inherited:
                segment = identity_text.strip()
            attrs = attributes(parent_text if inherited and len(segments) == 1 else segment, category)
            overrides = {}
            if inherited and len(segments) == 1:
                for source in [*reversed(inherited[:-1]), line]:
                    for key, value in attributes(REFERENCE.sub("", source.text), category).items():
                        if value is not None:
                            if attrs.get(key) != value and attrs.get(key) is not None:
                                overrides[key] = {"inherited": attrs[key], "local": value}
                                if key == "material":
                                    attrs["grade"] = None
                            attrs[key] = value
            section_attributes = {}
            for section in reversed(line.section_notes):
                section_text = section["title"] + "\n" + (section["notes"] or "")
                if families(section_text) != [category]:
                    continue
                for key, value in attributes(section_text, category).items():
                    if value is not None and attrs[key] is None:
                        attrs[key] = value
                        section_attributes[key] = section["section_id"]
            candidate_issues = list(issues)
            candidate_issues.extend(f"conflicting {key}" for key, value in attrs.items() if isinstance(value, list))
            scope_text = " ".join([segment, local] if len(segments) == 1 and not inherited else [segment])
            if inherited and len(segments) == 1:
                scope_text = local if any(pattern.search(local) for pattern in
                                          (SUPPLY, INSTALL, BY_OTHERS, ACTIVITY)) else segment
            relationship = scope_of(scope_text, included, len(segments) > 1 and bool(SUPPLY.search(local)))
            if (line.headline and category not in headline_families and not inherited
                    and relationship in {"supplied", "installed"} and line.headline.strip() != line.text.strip()):
                relationship = "unspecified"
            if relationship == "activity":
                continue
            raw_unit = line.raw_unit or line.unit
            unit = units.normalize(line.unit or raw_unit)
            measurements = ELEMENT_QUANTITY.findall(local if inherited and len(segments) == 1 else segment)
            element_quantity = None
            if len(measurements) == 1:
                raw_count, component_unit = measurements[0]
                element_quantity = Decimal(number(raw_count))
                unit = units.normalize(component_unit)
            quantity_basis = "paired" if attrs["basis"] == "paired" else (
                "single" if units.dimension(unit) == units.Dimension.LENGTH or unit == "ea" else "unresolved"
            )
            selection = ("companion" if line.duplicate else "unreconciled_source"
                         if line.source_role not in (None, "primary_scope") else "alternative"
                         if line.alternative_for else "conditional" if line.total_rule == "conditional"
                         else "unit_price_only" if line.total_rule == "unit_price_only"
                         else "selected")
            quantity = None
            derivation = "BOM quantity could not be assigned to this element"
            if relationship in {"supplied", "installed", "separately_measured"} and quantity_basis != "unresolved":
                if element_quantity is not None:
                    bom_quantity = units.convert(line.quantity, units.normalize(line.unit or raw_unit), unit) if (
                        line.quantity is not None and line.quantity.is_finite() and len(segments) == 1
                    ) else None
                    if bom_quantity is not None and bom_quantity != element_quantity:
                        derivation = "Conflicting explicit element and BOM quantities"
                    else:
                        quantity = str(element_quantity)
                        derivation = "Explicit element quantity in source text"
                elif (not measurements and len(segments) == 1 and line.pricing_basis == "unit_rate"
                      and line.quantity is not None and line.quantity.is_finite() and line.quantity >= 0):
                    quantity = str(line.quantity)
                    derivation = "Direct BOM quantity per " + ("pair" if quantity_basis == "paired" else "product")
            sku_match = SKU.search(local if len(segments) == 1 else segment) or SKU.search(segment)
            supplier_match = SUPPLIER.search(local if len(segments) == 1 else segment)
            results.append((line.id, slot, Candidate(
                name=segment, category=category, attributes=attrs,
                source={**line.locator, "position": line.code, "text": line.text,
                        "quote": (segment if segment in line.text else line.text).strip(),
                        "quantity": str(line.quantity) if line.quantity is not None else None,
                        "raw_quantity": line.raw_quantity, "unit": raw_unit, "pricing_basis": line.pricing_basis,
                        "total_rule": line.total_rule, "alternative_for": str(line.alternative_for)
                        if line.alternative_for else None, "source_role": line.source_role,
                        "companion_key": line.companion_key},
                context={"references": [{**item.locator, "bom_line_id": item.id, "position": item.code,
                                         "text": item.text} for item in inherited],
                         "source_reference_ids": list(line.reference_ids),
                         "overrides": overrides, "section_notes": line.section_notes,
                         "section_attributes": section_attributes},
                scope=relationship, selection=selection, quantity=quantity, unit=unit,
                quantity_basis=quantity_basis, derivation=derivation,
                sku=sku_match[1].casefold() if sku_match else None,
                supplier=canonical(supplier_match[1]) if supplier_match else None,
                issues=tuple(candidate_issues),
                local_identity_text=local.strip() if inherited and not local_families else "",
            )))
    return results


def code_key(code: str) -> str:
    return ".".join(str(int(part)) if part.isdecimal() else part.casefold() for part in code.strip(". ").split("."))


def families(text: str) -> list[str]:
    return [category for category, pattern in FAMILIES.items() if pattern.search(text)]


def split_products(text: str) -> list[tuple[str, str, bool]]:
    pieces = []
    start = 0
    included = False
    for match in SPLIT.finditer(text):
        left = families(text[start:match.start()])
        right_text = re.split(r"[;\n]", text[match.end():], maxsplit=1)[0]
        right = families(right_text if match[0] in {";", "\n"} else right_text[:70])
        if left and right and (match[0] != "\n" or set(right) - set(left)):
            pieces.append((text[start:match.start()].strip(), included))
            start = match.end()
            included = bool(INCLUDED.search(match[0]))
    pieces.append((text[start:].strip(), included))
    return [(category, piece, included) for piece, included in pieces for category in families(piece)]


def scope_of(text: str, included: bool, shared_supply: bool) -> str:
    if BY_OTHERS.search(text):
        return "provided_by_others"
    local_supply = SUPPLY.search(text)
    if ACTIVITY.search(text) and not local_supply:
        return "activity"
    prefix = INCLUDED.search(text)
    if included or (prefix and not families(text[:prefix.start()])):
        return "included_accessory"
    if SEPARATE.search(text):
        return "separately_measured"
    installation = INSTALL.search(text)
    if local_supply or (shared_supply and not installation):
        return "installed" if installation else "supplied"
    return "installation_only" if installation else "unspecified"


@dataclass(frozen=True)
class Product:
    id: str
    category: str
    name: str
    description: str
    supplier: str | None
    sku: str | None
    unit: str | None
    attributes: dict
    aliases: tuple[str, ...] = ()
    provenance: tuple[dict, ...] = ()

    @property
    def identity(self) -> str:
        return digest([self.category, self.name, self.description, self.supplier, self.sku, self.unit, self.attributes])

    def brief(self) -> dict:
        return {"id": self.id, "name": self.name, "category": self.category, "supplier": self.supplier,
                "sku": self.sku, "unit": self.unit, "attributes": self.attributes}


def compatibility(spec: dict, product: Product, *, strict: bool = True) -> list[str]:
    result = []
    if spec["category"] != product.category:
        result.append("category differs")
    for key, value in spec["attributes"].items():
        other = product.attributes.get(key)
        if isinstance(value, list) or isinstance(other, list):
            result.append(f"conflicting {key}")
        elif value != other and (strict or (value is not None and other is not None) or key == "basis"):
            result.append(f"{key} differs" if value is not None and other is not None else f"{key} is unknown on one side")
    unit = spec["unit_basis"]
    if unit == "length":
        if product.unit and units.dimension(product.unit) != units.Dimension.LENGTH:
            result.append("purchase unit requires conversion evidence")
    elif unit and product.unit and units.convert(Decimal(1), unit, product.unit) is None:
        result.append("purchase unit requires conversion evidence")
    if spec["sku"] and spec["sku"] != (product.sku or "").casefold():
        result.append("SKU differs")
    if spec["supplier"] and spec["supplier"] != canonical(product.supplier or ""):
        result.append("supplier differs")
    return result


def matching_name(text: str) -> str:
    cleaned = INSTALL.sub(" ", SUPPLY.sub(" ", text))
    return canonical(re.sub(r"\b(?:and|und)\b", " ", cleaned, flags=re.I))


def description_key(category: str, text: str) -> str:
    material_terms = [rf"\b(?:{pattern})\b" for pattern in MATERIALS.values()]
    syntax = r"\b(?:mm|cm|aus|of|and|und|jedoch|abweichend|but|pe[ -]?(?:100(?:[ -]?rc)?|80))\b"
    patterns = [FAMILIES[category].pattern, SKU.pattern, SUPPLIER.pattern, SIZE_PAIR.pattern, *DIMENSIONS.values(),
                *material_terms, SUPPLY.pattern, INSTALL.pattern, PAIR.pattern, syntax]
    for pattern in patterns:
        text = re.sub(pattern, " ", text, flags=re.I)
    return canonical(text)


def assess(candidate: Candidate, products: list[Product]) -> tuple[list[Product], list[dict]]:
    spec = candidate.specification
    exact, evidence = [], []
    for product in products:
        if product.category != candidate.category:
            continue
        names = (canonical(candidate.name), matching_name(candidate.name))
        approved_alias = any(name in product.aliases for name in names)
        named = approved_alias or canonical(product.name) in names
        identified = bool(candidate.sku and candidate.supplier)
        reasons = compatibility(spec, product, strict=not (identified or approved_alias))
        attrs = candidate.attributes
        sized = (attrs["material"] and (attrs["dn"] or (attrs["outside_mm"] and attrs["wall_mm"])))
        technical = bool(sized and not spec["description"] and not description_key(product.category, product.name)
                         and product.unit and spec["unit_basis"])
        rule_id = ("supplier_sku" if identified else "approved_name" if named else "technical_specification"
                   if technical else None)
        if candidate.category in PIPE_FAMILIES and rule_id and not reasons and not candidate.issues:
            exact.append(product)
        evidence.append({**product.brief(), "identity": product.identity, "rule": rule_id, "incompatibilities": reasons,
                         "catalogue_provenance": list(product.provenance)})
    evidence.sort(key=lambda item: (
        len(item["incompatibilities"]), item["rule"] is None, item["name"].casefold(), item["id"],
    ))
    return exact, evidence
