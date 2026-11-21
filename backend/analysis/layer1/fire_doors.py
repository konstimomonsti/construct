"""Check whether a tender gives the class for an explicitly fire-rated door."""

import re

from ..registry import rule
from .common import source_detail
from .text_defects import ordered_lines, refers_to_previous

RULE_ID = "L1.TEXT.FIRE_DOOR_RATING_MISSING"
_FIRE_DOOR = r"(?:Brandschutz|Feuerschutz)[ -]?(?:tür(?:en|elemente?)?|abschluss|abschlüsse)"
_DOOR = rf"(?:{_FIRE_DOOR}|(?:Stahl|Holz)[ -]?tür(?:en|elemente?)?|Tür(?:en|elemente?)?)"
_PREFIX = r"^\s*(?:(?:Ausführung\s+als|Liefern\s+und\s+montieren:|einflügelig[eern]*|zweiflügelig[eern]*)\s+)*"
_RATED_SUBJECT = re.compile(rf"{_PREFIX}{_FIRE_DOOR}\b", re.I)
_DOOR_SUBJECT = re.compile(rf"{_PREFIX}{_DOOR}\b", re.I)
_RATING = r"(?:T\s*-?\s*(?:30|60|90|120)(?:[ -]?RS)?|E(?:I[₁₂12]?|W)?\s*-?\s*\d{2,3})(?!\w|[.,]\d)"
_QUALITATIVE = r"(?:hochfeuerhemmend|feuerhemmend|feuerbeständig)\w*\b"
_RATING_VALUE = re.compile(rf"\b(?:{_RATING}|{_QUALITATIVE})", re.I)
_RATING_FIRST = re.compile(rf"^\s*{_RATING}(?:[ -]*RS\b|[ -]+C[0-5]\b)?[,\s-]+{_DOOR}\b", re.I)
_FIELD = r"(?:Feuerwiderstand(?:sklasse)?|Brandschutz(?:klasse)?)"
_FIELD_LABEL = re.compile(rf"^\s*{_FIELD}\s*[:=]\s*", re.I)
_REQUIRED_FIELD = re.compile(rf"^\s*{_FIELD}\s*[:=]?\s*(?:erforderlich|gefordert)\b", re.I)
_OPEN_FIELD = re.compile(r"^(?:[-–—]{2,}|noch\s+(?:offen|festzulegen)|TBD)\s*$", re.I)
_SCOPE_BREAK = re.compile(
    r"\b(?:mit(?!\s+(?:Feuerwiderstand|Brandschutz))|für|inkl\.?|einschl\.?|einschließlich|"
    r"Zarge|Türblatt|Rahmen|Beschlag|Verglasung|Dichtung|Wand)\b", re.I,
)
_CLAUSES = re.compile(r"[;\n]|\.(?=\s+\S)")
_EXISTING_WORK = re.compile(
    r"\b(?:abbruch\w*|ausbauen|demont\w*|entfern\w*|rückbau\w*|warten|wartung\w*|"
    r"prüfen|prüfung\w*|beschichten|lackieren|reinig\w*)\b", re.I,
)
_NEW_WORK = re.compile(r"\b(?:erneuern|ersetzen|austauschen|Ersatz|Neubau|neu\s+liefern|neu\s+einbauen)\b", re.I)
_NO_FIRE_REQUIREMENT = re.compile(
    r"\b(?:ohne\s+(?:Brandschutz\w*|Feuerwiderstand\w*)|keine?[nrms]?\s+Brandschutzanforderung\w*)\b",
    re.I,
)
_NEGATED_RATING = re.compile(r"\b(?:nicht|kein[e]?|ohne)\s*$", re.I)
_ALTERNATIVE = re.compile(r"\b(?:oder|alternativ|wahlweise)\b", re.I)
_REFERENCE = re.compile(
    r"\b(?:gemäß|nach|lt\.?|laut|siehe|entsprechend)\s+"
    r"(?:(?:der|dem)\s+)?(?:Tür(?:en)?list(?:e|en)|Türbuch|Türplan|Brandschutz(?:konzept|nachweis|plan))\b",
    re.I,
)


def _primary(clause: str) -> str:
    boundary = _SCOPE_BREAK.search(clause)
    return clause[:boundary.start()] if boundary else clause


def _rating_stated(clause: str) -> bool:
    if _RATING_FIRST.match(clause):
        return True
    field = _FIELD_LABEL.match(clause)
    value = clause[field.end():] if field else clause
    if not field and not _DOOR_SUBJECT.match(clause):
        return False
    primary = _primary(value)
    return any(not _NEGATED_RATING.search(primary[:rating.start()]) for rating in _RATING_VALUE.finditer(primary))


def _door_context(heading: str, clauses: list[str]) -> tuple[str | None, bool]:
    rated = _RATED_SUBJECT.match(heading) or (_RATED_SUBJECT.match(clauses[0]) if clauses else None)
    if not rated and not (_DOOR_SUBJECT.match(heading) or _RATING_FIRST.match(heading)):
        return None, False
    required = rated or next((match for clause in clauses if (match := _REQUIRED_FIELD.match(clause))), None)
    stated = any(_rating_stated(clause) for clause in [heading, *clauses])
    if required and clauses and _RATING_VALUE.fullmatch(clauses[0]):
        stated = True
    return (required[0].strip() if required else None), stated


@rule(RULE_ID, layer=1, category="text", severity="warning", title="Fire door rating missing",
      description="A fire-rated door or closure is explicitly required but has no stated classification or governing schedule reference.")
def fire_door_rating_missing(ctx):
    source_format = ctx.input.project.source_document.format
    sections = ctx.input.section_by_id()
    previous_rating: dict[str | None, bool] = {}
    for line in ordered_lines(ctx):
        heading = line.short_text or ""
        detail = source_detail(line, source_format) or ""
        clauses = [part.strip().rstrip(".") for part in _CLAUSES.split(detail) if part.strip()]
        required, stated = _door_context(heading, clauses)
        following_previous = refers_to_previous(line)
        inherited = following_previous and previous_rating.get(line.section_id, False)
        scope = _primary(heading)
        if clauses:
            scope += "\n" + _primary(clauses[0])
        existing_work_only = _EXISTING_WORK.search(scope) and not _NEW_WORK.search(scope)
        if not following_previous:
            previous_rating[line.section_id] = stated and not existing_work_only
        if (not required or stated or inherited or existing_work_only or _NO_FIRE_REQUIREMENT.search(scope)
                or _ALTERNATIVE.search(heading)):
            continue
        relevant_clauses = [heading, *(clause for clause in clauses if _DOOR_SUBJECT.match(clause) or _FIELD_LABEL.match(clause)
                                      or _REFERENCE.match(clause))]
        section = sections.get(line.section_id)
        if section and _RATED_SUBJECT.match(section.title or ""):
            relevant_clauses.append(section.title)
        if any(_rating_stated(clause) or _REFERENCE.search(_primary(clause)) for clause in relevant_clauses):
            continue
        if any((field := _FIELD_LABEL.match(clause)) and _OPEN_FIELD.fullmatch(clause[field.end():])
               for clause in relevant_clauses):
            continue  # The explicit placeholder rule owns this wording.
        yield ctx.finding(
            line=line,
            field="short_text" if required in heading else "long_text",
            message=f"{line.code}: the tender calls for a fire-rated door but does not state its classification.",
            evidence={
                "missing_property": "fire_rating",
                "quote": required,
                "bieterfrage_de": f"Zu Pos. {line.code}: Bitte nennen Sie die erforderliche Feuerwiderstandsklasse "
                                  "für das Türelement oder verweisen Sie auf die hierfür maßgebende Türliste.",
            },
        )
