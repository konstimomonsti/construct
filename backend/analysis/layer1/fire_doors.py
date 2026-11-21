"""Check whether a tender gives the class for an explicitly fire-rated door."""

from dataclasses import dataclass
import re

from ..registry import rule
from .common import OR_EQUIVALENT, source_detail

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
_ANCILLARY_SUBJECT = re.compile(r"^\s*(?:Zarge|Türblatt|Rahmen|Beschlag|Verglasung|Wand|Anschluss)\b", re.I)
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


# EN designation families and qualifiers are kept distinct. Normalization
# changes only typography and qualifier order.
_CLASS_SUBSCRIPTS = str.maketrans("₁₂₃₄₀ₐ", "12340a")
_CLASS = re.compile(r"(?<!\w)(?P<family>EI[12₁₂]|EW|E|T)[ \t]*-?[ \t]*"
                    r"(?P<minutes>15|20|30|45|60|90|120|180|240|360)(?!\d)", re.I)
_QUALIFIER = re.compile(r"(?:RS|S[ \t]*[2₂][0₀][0₀]|S[Aₐ][34₃₄]?|C[0-5]?)(?!\w)", re.I)
_QUALIFIER_SEPARATOR = re.compile(r"[ \t]*[-–,]?[ \t]*")
_MINIMUM = re.compile(r"(?:mindestens|min\.|≥|>=)\s*$", re.I)
_UNCERTAIN_CLASS = re.compile(r"\b(?:falls|sofern|wenn|optional|gegebenenfalls|höchstens|"
                              r"maximal|bis|bisher|vorhanden|Bestand|bei|Typ|Modell|Art\.?-?Nr\.?)\b|\?", re.I)


@dataclass(frozen=True)
class FireClass:
    family: str
    minutes: int
    qualifiers: tuple[str, ...]

    def label(self) -> str:
        return " ".join((self.family, str(self.minutes), *self.qualifiers))


def _read_class(match):
    qualifiers = set()
    end = match.end()
    while True:
        separator = _QUALIFIER_SEPARATOR.match(match.string, end)
        suffix = _QUALIFIER.match(match.string, separator.end())
        if not suffix:
            break
        qualifiers.add("".join(suffix[0].translate(_CLASS_SUBSCRIPTS).upper().split()))
        end = suffix.end()
    family = match["family"].translate(_CLASS_SUBSCRIPTS).upper()
    minutes = int(match["minutes"])
    if family == "T" and minutes not in {30, 60, 90, 120}:
        return None
    if (family == "T" and qualifiers - {"RS"}) or (family != "T" and "RS" in qualifiers):
        return None
    if sum(q.startswith("C") for q in qualifiers) > 1 or sum(q.startswith("S") for q in qualifiers) > 1:
        return None
    return FireClass(family, minutes, tuple(sorted(qualifiers))), end


def parse_fire_class(value, unit=None):
    if unit or not isinstance(value, str):
        return None
    text = value.strip()
    match = _CLASS.match(text)
    if match and (parsed := _read_class(match)) and parsed[1] == len(text):
        return parsed[0]
    return None


def written_fire_class(heading, detail, *, detail_only=False):
    """Return one class explicitly scoped to a new door assembly on this position."""
    heading = heading or ""
    detail = detail or ""
    if not (_DOOR_SUBJECT.match(heading) or _RATING_FIRST.match(heading)):
        return None
    heading_scope = _primary(heading)
    if (_EXISTING_WORK.search(heading_scope) or _NO_FIRE_REQUIREMENT.search(heading_scope)
            or _ALTERNATIVE.search(OR_EQUIVALENT.sub("", heading + "\n" + detail))):
        return None
    matches = {}
    fields = [("long_text", detail)] if detail_only else [("short_text", heading), ("long_text", detail)]
    for field, text in fields:
        active = True
        for clause in _CLAUSES.split(text):
            named = _DOOR_SUBJECT.match(clause) or _RATING_FIRST.match(clause)
            if named:
                active = True
            elif _ANCILLARY_SUBJECT.match(clause):
                active = False
            attributed = named or (active and _FIELD_LABEL.match(clause))
            primary = _primary(clause)
            if not attributed or _UNCERTAIN_CLASS.search(primary) or _EXISTING_WORK.search(primary):
                continue
            for match in _CLASS.finditer(primary):
                if _NEGATED_RATING.search(primary[:match.start()]) or not (parsed := _read_class(match)):
                    return None
                rating, end = parsed
                tail = primary[end:]
                if re.match(r"\w|\s*/|[.,]\d|\s*(?:mm|cm)\b|\s*\(", tail, re.I):
                    return None
                if re.match(r"\s*[-–]\s*\w", tail) and not _RATING_FIRST.match(clause):
                    return None
                minimum = _MINIMUM.search(primary[:match.start()])
                quote = primary[minimum.start() if minimum else match.start():end]
                matches.setdefault(rating, (rating, False, field, quote))
                if minimum:
                    matches[rating] = (rating, True, field, quote)
    if not matches:
        return None
    # A detailed designation may expand a heading that repeats only the family
    # and duration. Use the fuller quote only when it covers every stated token.
    most_specific = max(matches, key=lambda rating: len(rating.qualifiers))
    if all((rating.family, rating.minutes) == (most_specific.family, most_specific.minutes)
           and set(rating.qualifiers).issubset(most_specific.qualifiers) for rating in matches):
        return matches[most_specific]
    return None


def door_class_discrepancy(heading, detail):
    left = written_fire_class(heading, "")
    right = written_fire_class(heading, detail, detail_only=True)
    if left and not right and (bare := parse_fire_class((detail or "").strip().rstrip("."))):
        right = (bare, False, "long_text", detail.strip().rstrip("."))
    if not left and (bare := parse_fire_class((heading or "").strip().rstrip("."))):
        left = (bare, False, "short_text", heading.strip().rstrip("."))
        if detail_class := parse_fire_class((detail or "").strip().rstrip(".")):
            right = (detail_class, False, "long_text", detail.strip().rstrip("."))
    if not left or not right:
        return None
    a, a_minimum, _, a_quote = left
    b, b_minimum, _, b_quote = right
    if a.family != b.family:
        return a_quote, b_quote, "comparison_unverified"
    compatible_bounds = ((a_minimum and b_minimum) or (a_minimum and b.minutes >= a.minutes)
                         or (b_minimum and a.minutes >= b.minutes))
    if a.minutes != b.minutes and not compatible_bounds:
        return a_quote, b_quote, "conflict"
    smoke_a = {q for q in a.qualifiers if q.startswith("S") or q == "RS"}
    smoke_b = {q for q in b.qualifiers if q.startswith("S") or q == "RS"}
    closure_a = {q for q in a.qualifiers if q.startswith("C") and q != "C"}
    closure_b = {q for q in b.qualifiers if q.startswith("C") and q != "C"}
    if smoke_a and smoke_b and smoke_a != smoke_b or closure_a and closure_b and closure_a != closure_b:
        return a_quote, b_quote, "comparison_unverified"
    return None


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
    from .text_defects import ordered_lines, refers_to_previous

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
