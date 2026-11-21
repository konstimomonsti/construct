"""DIN 1045-2 screening: strength classes against exposure-class minimums (matrix from the task specification)."""

from dataclasses import dataclass
import re

from ..registry import rule
from .common import label, review_fix, source_detail, text_of
from .concrete_scope import mentions, preceding_components
from .structural_fire import structural_fire_review
from .textvalues import EXPOSURE, GRADE, NORMAL_GRADES, STANDARD_GRADES, grades

STRENGTH_RANK = {grade: rank for rank, grade in enumerate(NORMAL_GRADES, 1)}
EXPOSURE_MIN_STRENGTH = {
    "XC1": "C16/20", "XC2": "C16/20", "XC3": "C20/25", "XC4": "C25/30",
    "XF1": "C25/30", "XF2": "C25/30", "XF3": "C25/30", "XF4": "C30/37",
    "XD1": "C30/37", "XD2": "C35/45", "XD3": "C35/45",
    "XS1": "C30/37", "XS2": "C35/45", "XS3": "C35/45",
}
NOTES = {
    "XF2": "Bitte bestätigen Sie, ob LP-Beton erforderlich ist oder C35/45 ohne LP zugelassen wird.",
    "XF4": "Bitte bestätigen Sie die Anforderungen an LP-Beton für die Expositionsklasse XF4.",
    "WA": "Bitte bestätigen Sie die Anforderungen der Alkali-Richtlinie und den Nachweis geeigneter Gesteinskörnung durch das Fertigteilwerk.",
}


def facts(text: str, grade: str | None, required: str | None = None) -> dict:
    return {"grade": grade, "exposure": sorted(set(EXPOSURE.findall(text))), "required_min": required}


# Short expressions such as "C35/45, XC2, XF2, WA" carry their own attribution.
# Only bridge punctuation, a recognised LP qualifier, or the exposure label.
_EXPOSURE_LABEL = r"(?i:Expositionsklasse(?:n)?|Exposition)"
_EXPOSURE_CODES = rf"{EXPOSURE.pattern}(?:[\s,/+]+(?:(?i:und)\s+)?{EXPOSURE.pattern})*"
_AFTER_GRADE = re.compile(
    rf"^\s*[,/:]?\s*(?:\((?i:LP|Luftporenbeton)\)\s*[,/:]?\s*)?"
    rf"(?:{_EXPOSURE_LABEL}\s*[:=]?\s*)?\(?(?P<codes>{_EXPOSURE_CODES})"
)
_LABEL_BEFORE = re.compile(rf"{_EXPOSURE_LABEL}\s*[:=]?\s*$")
_ALTERNATIVES = re.compile(rf"{GRADE.pattern}\s*(?:\([^()]*\)\s*)?(?i:oder|bzw\.|bis|wahlweise|/)\s*$")
_CLAUSE_BOUNDARY = re.compile(r"[;\n]|(?<!\d)\.(?!\d)|\.(?=\s)")


@dataclass(frozen=True)
class ExposurePair:
    grade: str
    components: frozenset[str]
    codes: tuple[str, ...]
    grade_quote: str
    grade_field: str
    exposure_quote: str
    exposure_field: str

    def evidence(self, required=None):
        return {
            "din": {"grade": self.grade, "exposure": list(self.codes), "required_min": required},
            "components": sorted(self.components),
            "grade_quote": self.grade_quote, "grade_field": self.grade_field,
            "exposure_quote": self.exposure_quote, "exposure_field": self.exposure_field,
        }

    def discriminator(self, exposure):
        if not self.components:
            return exposure
        return f"{exposure}:{','.join(sorted(self.components))}:{self.grade}"


def _exposure_pairs(line, source_format):
    detail = source_detail(line, source_format)
    fields = {"short_text": line.short_text or "", "long_text": detail or ""}
    sources = [(field, item) for field, text in fields.items() for item in mentions(text)]
    if not sources:
        return [], {}, set()
    spans = set()
    pairs = []
    for field, item in sources:
        start, end = item.grade_span
        text = fields[field]
        nearby = text[max(0, start - 75):start]
        after = text[end:]
        if _ALTERNATIVES.search(nearby):
            continue
        if not item.components:
            clause = _CLAUSE_BOUNDARY.split(nearby)[-1] + text[start:end] + _CLAUSE_BOUNDARY.split(after, maxsplit=1)[0]
            if len(grades(clause)) > 1:
                continue
        match = _AFTER_GRADE.match(after)
        if not match:
            continue
        codes = tuple(sorted(set(EXPOSURE.findall(match["codes"]))))
        quote = match["codes"]
        pairs.append(ExposurePair(item.grade, item.components, codes, item.quote, field, quote, field))
        spans.update((field, end + match.start("codes") + token.start()) for token in EXPOSURE.finditer(quote))

    # A separate attribute can refer to the same named component. A dedicated
    # exposure label may also complete a single, unscoped concrete specification.
    unresolved = {}
    for field, text in fields.items():
        for match in EXPOSURE.finditer(text):
            if (field, match.start()) in spans:
                continue
            prefix = text[:match.start()]
            header = _LABEL_BEFORE.search(prefix)
            if not header:
                # In a list, the later exposures share the same label as the first.
                prefix = re.sub(rf"{_EXPOSURE_CODES}[\s,/+]+$", "", prefix, count=1)
                header = _LABEL_BEFORE.search(prefix)
            scope = preceding_components(prefix[:header.start()] if header else prefix)
            candidates = [(name, item) for name, item in sources if scope and scope <= item.components]
            if header and not scope and not any(item.components for _, item in sources):
                candidates = sources
            values = {item.grade for _, item in candidates}
            matching = {pair.grade for pair in pairs if match[0] in pair.codes and pair.components == scope}
            quote = text[header.start():match.end()] if header else match[0]
            if len(values) == 1:
                grade_field, item = candidates[0]
                if item.grade not in matching:
                    pairs.append(ExposurePair(item.grade, scope, (match[0],), item.quote,
                                              grade_field, quote, field))
            elif not matching:
                unresolved.setdefault(match[0], (field, quote, scope))
    return pairs, unresolved, {item.grade for _, item in sources}


@rule("L1.DIN.EXPOSURE_STRENGTH", layer=1, category="din", severity="error",
      title="Concrete grade below exposure minimum", description="Compares a source-linked concrete specification against the supplied exposure matrix.")
def exposure_strength(ctx):
    source_format = ctx.input.project.source_document.format
    for line in ctx.input.lines:
        pairs, _, _ = _exposure_pairs(line, source_format)
        seen = set()
        for pair in pairs:
            if pair.grade not in STRENGTH_RANK:
                continue
            component = ", ".join(part.title() for part in sorted(pair.components))
            for exposure in pair.codes:
                required = EXPOSURE_MIN_STRENGTH.get(exposure)
                if not required or STRENGTH_RANK[pair.grade] >= STRENGTH_RANK[required]:
                    continue
                discriminator = pair.discriminator(exposure)
                if discriminator in seen:
                    continue
                seen.add(discriminator)
                subject = f" for {component}" if component else ""
                german_subject = f" für {component}" if component else ""
                yield ctx.finding(
                    line=line, field=pair.exposure_field, discriminator=discriminator,
                    message=f"{label(line)}: {pair.grade} is below {required} for {exposure}{subject} in the screening matrix.",
                    evidence={**pair.evidence(required), "exposure": exposure,
                              "bieterfrage_de": f"Zu Pos. {line.code}: Bitte bestätigen Sie die Betonfestigkeitsklasse"
                                                f"{german_subject} bei {exposure}. Die Prüfmatrix nennt {required}."},
                    suggested_fix=review_fix(
                        f"Confirm the governing exposure and concrete specification{subject}. "
                        "Align the tender and product declaration with the approved strength class."
                    ),
                )


@rule("L1.DIN.EXPOSURE_SCOPE", layer=1, category="din", severity="info",
      title="Concrete grade and exposure need attribution",
      description="Requests clarification when the source does not link an exposure in the screening matrix to a unique concrete grade.")
def exposure_scope(ctx):
    source_format = ctx.input.project.source_document.format
    for line in ctx.input.lines:
        _, unresolved, stated = _exposure_pairs(line, source_format)
        if stated.isdisjoint(STRENGTH_RANK):
            continue
        for exposure in sorted(unresolved.keys() & EXPOSURE_MIN_STRENGTH.keys()):
            field, quote, components = unresolved[exposure]
            yield ctx.finding(
                line=line, field=field, discriminator=exposure,
                message=f"{label(line)} does not identify the concrete grade that applies to {exposure}.",
                evidence={"din": {"grade": None, "exposure": [exposure], "required_min": None},
                          "exposure": exposure, "stated_grades": sorted(stated), "components": sorted(components),
                          "exposure_quote": quote, "exposure_field": field,
                          "bieterfrage_de": f"Zu Pos. {line.code}: Bitte ordnen Sie die Expositionsklasse {exposure} "
                                            "und die Betonfestigkeitsklasse dem jeweiligen Bauteil eindeutig zu."},
                suggested_fix=review_fix(
                    "Identify the concrete component in the tender or drawings and state its grade and exposure together."
                ),
            )


@rule("L1.DIN.UNKNOWN_GRADE", layer=1, category="din", severity="warning",
      title="Concrete grade is not a standard class", description="A stated concrete class is not a DIN EN 206 strength class (likely a typo).")
def unknown_grade(ctx):
    for line in ctx.input.lines:
        text = text_of(line)
        for grade in sorted(grades(text) - STANDARD_GRADES):
            yield ctx.finding(line=line, field="long_text", discriminator=grade,
                message=f"{label(line)}: {grade} is not a DIN EN 206 strength class; please check for a typo.",
                evidence={"din": facts(text, grade),
                          "bieterfrage_de": f"Zu Pos. {line.code}: Bitte bestätigen Sie die Betonfestigkeitsklasse {grade} und deren Eignung für die angegebenen Expositionsklassen."})


@rule("L1.DIN.NOTE", layer=1, category="din", severity="info",
      title="Exposure class requires clarification", description="LP-concrete notes for XF2/XF4 and alkali guideline note for WA, once per line and exposure.")
def special_notes(ctx):
    source_format = ctx.input.project.source_document.format
    for line in ctx.input.lines:
        pairs, unresolved, stated = _exposure_pairs(line, source_format)
        if not stated:
            continue
        notes = set(unresolved) | {code for pair in pairs for code in pair.codes}
        for exposure in sorted(notes & NOTES.keys()):
            matching = [pair for pair in pairs if exposure in pair.codes]
            unique = {(pair.grade, pair.components) for pair in matching}
            if len(unique) == 1 and exposure not in unresolved:
                evidence = matching[0].evidence(EXPOSURE_MIN_STRENGTH.get(exposure))
                field = matching[0].exposure_field
            else:
                evidence = {"din": {"grade": None, "exposure": [exposure], "required_min": None}}
                field = unresolved.get(exposure, ("long_text", "", ()))[0]
            yield ctx.finding(line=line, field=field, discriminator=exposure,
                message=f"{label(line)}: {exposure}. {NOTES[exposure]}",
                evidence={**evidence, "exposure": exposure,
                          "bieterfrage_de": f"Zu Pos. {line.code}: {NOTES[exposure]}"})

# Extended norm checks use only explicit facts stated on the position.
from decimal import Decimal
from . import textvalues as tv


@rule("L1.DIN.WATERPROOFING_MISSING", layer=1, category="din", severity="warning",
      title="Waterproofing specification missing", description="Checks ground-contact precast and plinth specifications.")
def waterproofing_missing(ctx):
    for line in ctx.input.lines:
        text = text_of(line)
        if tv.PRECAST_PLINTH.search(text) and tv.GROUND_CONTACT.search(text) and not (tv.WATER_IMPACT.search(text) or tv.WATERPROOFING.search(text)):
            yield ctx.finding(line=line, field="long_text", message=f"{label(line)}: Ground-contact precast or plinth work lacks a water-impact class or waterproofing specification.",
                evidence={"standard": "DIN 18533", "water_impact_class": None, "waterproofing": None, "bieterfrage_de": f"Zu Pos. {line.code}: Das Bauteil befindet sich im Erd-/Spritzwasserbereich. Welche Wassereinwirkungsklasse nach DIN 18533 und welche Abdichtungsmaßnahme sind vorgesehen?"})


@rule("L1.DIN.FIRE_RATING_CONFLICT", layer=1, category="din", severity="error",
      title="Fire resistance requirement unclear", description="Checks written ratings attributed to the same structural item.")
def fire_rating_conflict(ctx):
    source_format = ctx.input.project.source_document.format
    for line in ctx.input.lines:
        review = structural_fire_review(line.short_text, source_detail(line, source_format))
        if not review:
            continue
        outcome, short, long = review
        missing = outcome == "missing"
        statement = ("The fire wall has no attributed fire-resistance classification." if missing else
                     f"The heading states {short} and the detail states {long} for this component.")
        question = ("Bitte geben Sie die maßgebliche Feuerwiderstandsklasse der Brandwand an." if missing else
                    f"Welche Feuerwiderstandsklasse gilt für dieses Bauteil ({short} / {long})?")
        yield ctx.finding(
            line=line, field="long_text", message=f"{label(line)}: {statement}",
            severity="info" if outcome == "comparison_unverified" else "error",
            evidence={"standard": "DIN 4102 / DIN EN 13501", "outcome": outcome,
                      "short_ratings": [short] if short else [], "long_ratings": [long] if long else [],
                      "short_quote": short, "long_quote": long, "unclassified_fire_wall": missing,
                      "bieterfrage_de": f"Zu Pos. {line.code}: {question}"},
            suggested_fix=review_fix("Confirm the classification for the named component in the fire strategy and align the tender wording."),
        )


@rule("L1.DIN.VOB_DEDUCTION_VIOLATION", layer=1, category="din", severity="warning",
      title="Opening deduction requires clarification", description="Screens explicit opening deduction limits against DIN 18331 thresholds.")
def vob_deduction_violation(ctx):
    for line in ctx.input.lines:
        text = text_of(line)
        # Evaluate individual clauses to avoid pairing unrelated quantities with an opening.
        import re
        for clause in re.split(r"[;\n]", text):
            if not (tv.VOB_OPENING.search(clause) and tv.VOB_DEDUCTION.search(clause)):
                continue
            for match in tv.VOB_LIMIT.finditer(clause):
                number, unit = match.groups()
                limit = Decimal("0.5") if unit.lower() in {"m³", "m3", "cbm"} else Decimal("2.5")
                if Decimal(number.replace(",", ".")) <= limit:
                    yield ctx.finding(line=line, field="long_text", message=f"{label(line)}: The opening deduction clause includes openings at or below the DIN 18331 screening threshold ({limit} {unit}).",
                        evidence={"standard": "DIN 18331", "stated_limit": number, "unit": unit, "screening_threshold": str(limit), "clause": clause.strip(), "bieterfrage_de": f"Zu Pos. {line.code}: Die Ausschreibung sieht den Abzug kleiner Aussparungen vor. Bitte klären Sie die Abrechnung im Hinblick auf die Übermessungsgrenzen nach VOB/C DIN 18331."})
                    break
            else:
                continue
            break


@rule("L1.DIN.REBAR_UNKNOWN_GRADE", layer=1, category="din", severity="warning",
      title="Unknown reinforcing steel grade", description="Checks stated reinforcement grades against the supported DIN 488 designations.")
def rebar_unknown_grade(ctx):
    for line in ctx.input.lines:
        text = text_of(line)
        if not tv.REBAR_KEYWORD.search(text):
            continue
        for grade in sorted({m.group().strip() for m in tv.REBAR_GRADE.finditer(text) if not tv.REBAR_VALID.fullmatch(m.group().strip())}):
            yield ctx.finding(line=line, field="long_text", discriminator=grade.upper(), message=f"{label(line)}: Reinforcing steel grade {grade} is not a supported DIN 488 designation.",
                evidence={"standard": "DIN 488", "grade": grade, "valid_grades": ["B500A", "B500B", "B500NR", "Bst 500 S", "Bst 500 M"], "bieterfrage_de": f"Zu Pos. {line.code}: Der angegebene Betonstahl {grade} ist nicht als DIN-488-Bezeichnung erkannt. Bitte bestätigen Sie die geforderte Stahlsorte und Duktilitätsklasse."})


@rule("L1.DIN.TOLERANCE_UNSPECIFIED", layer=1, category="din", severity="info",
      title="Special tolerance unspecified", description="Checks enhanced accuracy demands for an explicit tolerance class or table line.")
def tolerance_unspecified(ctx):
    for line in ctx.input.lines:
        text = text_of(line)
        if tv.TOLERANCE_DEMAND.search(text) and not tv.TOLERANCE_SPEC.search(text):
            yield ctx.finding(line=line, field="long_text", message=f"{label(line)}: Enhanced accuracy is requested without a specified tolerance table line or class.",
                evidence={"standard": "DIN 18202 / DIN 18203-1", "requirement": tv.TOLERANCE_DEMAND.search(text).group(), "bieterfrage_de": f"Zu Pos. {line.code}: Es werden erhöhte Anforderungen an die Genauigkeit gestellt. Bitte definieren Sie die zulässigen Grenzabweichungen nach DIN 18202 oder DIN 18203-1."})
