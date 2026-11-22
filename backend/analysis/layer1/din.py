"""DIN 1045-2 screening: strength classes against exposure-class minimums (matrix from the task specification)."""

from ..registry import rule
from .common import excerpt, label, text_of
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


@rule("L1.DIN.EXPOSURE_STRENGTH", layer=1, category="din", severity="error",
      title="Concrete grade below exposure minimum", description="Checks stated concrete against the supplied DIN 1045-2 exposure matrix.")
def exposure_strength(ctx):
    for line in ctx.input.lines:
        text = text_of(line)
        stated = grades(text)
        # Several classes can refer to different components; do not invent a pairing.
        if len(stated) != 1:
            continue
        grade = next(iter(stated))
        if grade not in STRENGTH_RANK:
            continue
        for exposure in sorted(set(EXPOSURE.findall(text))):
            required = EXPOSURE_MIN_STRENGTH.get(exposure)
            if required and STRENGTH_RANK[grade] < STRENGTH_RANK[required]:
                yield ctx.finding(line=line, field="long_text", discriminator=exposure,
                    message=f"{label(line)}: {grade} is below {required} for {exposure} in the screening matrix.",
                    evidence={"din": facts(text, grade, required), "exposure": exposure,
                              "bieterfrage_de": f"Zu Pos. {line.code}: Bitte klären Sie die Betonfestigkeitsklasse {grade} für {exposure}; die Prüfmatrix fordert mindestens {required}."})


@rule("L1.DIN.UNKNOWN_GRADE", layer=1, category="din", severity="warning",
      title="Verify the stated concrete class", description="A stated concrete class is not a DIN EN 206 strength class (likely a typo).")
def unknown_grade(ctx):
    for line in ctx.input.lines:
        text = text_of(line)
        for grade in sorted(grades(text) - STANDARD_GRADES):
            yield ctx.finding(line=line, field="long_text", discriminator=grade,
                message=f"{label(line)}: {grade} is outside the DIN EN 206 classes supported by this check. Confirm the specified class.",
                evidence={"din": facts(text, grade), "standard": "DIN EN 206",
                          "excerpt": excerpt(text, next(m for m in GRADE.finditer(text) if grades(m[0]) == {grade})),
                          "bieterfrage_de": f"Zu Pos. {line.code}: Bitte bestätigen Sie die Betonfestigkeitsklasse {grade} und deren Eignung für die angegebenen Expositionsklassen."})


@rule("L1.DIN.NOTE", layer=1, category="din", severity="info",
      title="Exposure class requires clarification", description="LP-concrete notes for XF2/XF4 and alkali guideline note for WA, once per line and exposure.")
def special_notes(ctx):
    for line in ctx.input.lines:
        text = text_of(line)
        stated = grades(text)
        if not stated:
            continue
        for exposure in sorted(set(EXPOSURE.findall(text)) & NOTES.keys()):
            yield ctx.finding(line=line, field="long_text", discriminator=exposure,
                message=f"{label(line)}: {exposure}. {NOTES[exposure]}",
                evidence={"din": facts(text, next(iter(stated)) if len(stated) == 1 else None,
                                       EXPOSURE_MIN_STRENGTH.get(exposure)), "exposure": exposure,
                          "bieterfrage_de": f"Zu Pos. {line.code}: {NOTES[exposure]}"})

# Extended norm checks use only explicit facts stated on the position.
from decimal import Decimal
from . import textvalues as tv


@rule("L1.DIN.WATERPROOFING_MISSING", layer=1, category="din", severity="warning",
      title="Waterproofing specification missing", description="Checks ground-contact precast and plinth specifications.")
def waterproofing_missing(ctx):
    for line in ctx.input.lines:
        text = text_of(line)
        contact = tv.GROUND_CONTACT.search(text)
        if tv.PRECAST_PLINTH.search(text) and contact and not (tv.WATER_IMPACT.search(text) or tv.WATERPROOFING.search(text)):
            yield ctx.finding(line=line, field="long_text",
                message=f"{label(line)}: the item mentions {contact[0]!r}. Confirm the water-impact class and "
                        "which package supplies the waterproofing specified under DIN 18533.",
                evidence={"standard": "DIN 18533", "excerpt": excerpt(text, contact),
                          "water_impact_class": None, "waterproofing": None, "bieterfrage_de": f"Zu Pos. {line.code}: Das Bauteil befindet sich im Erd-/Spritzwasserbereich. Welche Wassereinwirkungsklasse nach DIN 18533 und welche Abdichtungsmaßnahme sind vorgesehen?"})


@rule("L1.DIN.FIRE_RATING_CONFLICT", layer=1, category="din", severity="error",
      title="Fire resistance requirement unclear", description="Checks conflicting ratings and unclassified fire walls.")
def fire_rating_conflict(ctx):
    for line in ctx.input.lines:
        short = {f"{a.upper()}{b}" for a, b in tv.FIRE_RATING.findall(line.short_text or "")}
        long = {f"{a.upper()}{b}" for a, b in tv.FIRE_RATING.findall(line.long_text or "")}
        conflict = bool(short and long and {x for x in short} != {x for x in long})
        unclassified = bool(tv.FIRE_WALL.search(text_of(line)) and not (short or long))
        if conflict or unclassified:
            a, b = ", ".join(sorted(short)) or "keine Angabe", ", ".join(sorted(long)) or "keine Angabe"
            yield ctx.finding(line=line, field="long_text", message=f"{label(line)}: " + (f"Short and long text specify different fire ratings ({a} vs. {b})." if conflict else "The fire wall has no stated fire-resistance rating."),
                evidence={"standard": "DIN 4102 / DIN EN 13501", "short_ratings": sorted(short), "long_ratings": sorted(long), "unclassified_fire_wall": unclassified, "bieterfrage_de": f"Zu Pos. {line.code}: Die Brandschutzanforderung ist unklar ({a} gegenüber {b}). Bitte bestätigen Sie die maßgebliche Feuerwiderstandsklasse nach DIN 4102 / DIN EN 13501."})


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
                    yield ctx.finding(line=line, field="long_text", message=f"{label(line)}: {clause.strip()!r}. Check whether the DIN 18331 screening "
                                f"threshold of {limit} {unit} applies and which deduction to price.",
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
        found = {m[0].strip(): m for m in tv.REBAR_GRADE.finditer(text)
                 if not tv.REBAR_VALID.fullmatch(m[0].strip())}
        for grade, match in sorted(found.items()):
            yield ctx.finding(line=line, field="long_text", discriminator=grade.upper(), message=f"{label(line)}: Reinforcing steel grade {grade} is outside the DIN 488 designations supported by this check. Confirm the steel grade and ductility class.",
                evidence={"standard": "DIN 488", "excerpt": excerpt(text, match), "grade": grade, "valid_grades": ["B500A", "B500B", "B500NR", "Bst 500 S", "Bst 500 M"], "bieterfrage_de": f"Zu Pos. {line.code}: Der angegebene Betonstahl {grade} ist nicht als DIN-488-Bezeichnung erkannt. Bitte bestätigen Sie die geforderte Stahlsorte und Duktilitätsklasse."})


@rule("L1.DIN.TOLERANCE_UNSPECIFIED", layer=1, category="din", severity="info",
      title="Special tolerance unspecified", description="Checks enhanced accuracy demands for an explicit tolerance class or table line.")
def tolerance_unspecified(ctx):
    for line in ctx.input.lines:
        text = text_of(line)
        if tv.TOLERANCE_DEMAND.search(text) and not tv.TOLERANCE_SPEC.search(text):
            yield ctx.finding(line=line, field="long_text", message=f"{label(line)}: Enhanced accuracy is requested without a specified tolerance table line or class.",
                evidence={"standard": "DIN 18202 / DIN 18203-1", "requirement": tv.TOLERANCE_DEMAND.search(text).group(), "bieterfrage_de": f"Zu Pos. {line.code}: Es werden erhöhte Anforderungen an die Genauigkeit gestellt. Bitte definieren Sie die zulässigen Grenzabweichungen nach DIN 18202 oder DIN 18203-1."})
