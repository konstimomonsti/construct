"""DIN screening using the task specification's deliberately limited matrix."""

from ..registry import rule
from .common import label, text_of
from .textvalues import EXPOSURE, grades

STRENGTH_RANK = {grade: rank for rank, grade in enumerate(
    ("C16/20", "C20/25", "C25/30", "C30/37", "C35/45", "C40/50", "C45/55", "C50/60"), 1)}
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
    return {"grade": grade, "exposure": sorted(set(EXPOSURE.findall(text.upper()))), "required_min": required}


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
        for exposure in sorted(set(EXPOSURE.findall(text.upper()))):
            required = EXPOSURE_MIN_STRENGTH.get(exposure)
            if required and STRENGTH_RANK[grade] < STRENGTH_RANK[required]:
                yield ctx.finding(line=line, field="long_text", discriminator=exposure,
                    message=f"{label(line)}: {grade} is below {required} for {exposure} in the screening matrix.",
                    evidence={"din": facts(text, grade, required), "exposure": exposure,
                              "bieterfrage_de": f"Zu Pos. {line.code}: Bitte klären Sie die Betonfestigkeitsklasse {grade} für {exposure}; die Prüfmatrix fordert mindestens {required}."})


@rule("L1.DIN.UNKNOWN_GRADE", layer=1, category="din", severity="warning",
      title="Concrete grade outside screening table", description="A stated concrete class, including LC classes, is absent from the supplied rank table.")
def unknown_grade(ctx):
    for line in ctx.input.lines:
        text = text_of(line)
        for grade in sorted(grades(text) - STRENGTH_RANK.keys()):
            yield ctx.finding(line=line, field="long_text", discriminator=grade,
                message=f"{label(line)}: {grade} is not in the screening table; compliance cannot be assessed.",
                evidence={"din": facts(text, grade),
                          "bieterfrage_de": f"Zu Pos. {line.code}: Bitte bestätigen Sie die Betonfestigkeitsklasse {grade} und deren Eignung für die angegebenen Expositionsklassen."})


@rule("L1.DIN.NOTE", layer=1, category="din", severity="info",
      title="Exposure class requires clarification", description="LP-concrete notes for XF2/XF4 and alkali guideline note for WA, once per line and exposure.")
def special_notes(ctx):
    for line in ctx.input.lines:
        text = text_of(line)
        stated = grades(text)
        if not stated:
            continue
        for exposure in sorted(set(EXPOSURE.findall(text.upper())) & NOTES.keys()):
            yield ctx.finding(line=line, field="long_text", discriminator=exposure,
                message=f"{label(line)}: {exposure}. {NOTES[exposure]}",
                evidence={"din": facts(text, next(iter(stated)) if len(stated) == 1 else None,
                                       EXPOSURE_MIN_STRENGTH.get(exposure)), "exposure": exposure,
                          "bieterfrage_de": f"Zu Pos. {line.code}: {NOTES[exposure]}"})
