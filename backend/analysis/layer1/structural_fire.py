"""Attribute written fire-resistance designations to the structural work item."""

import re

from .common import OR_EQUIVALENT

_CLASS = re.compile(r"\b(?P<family>REI|RE|EI|R|F)\s*-?\s*(?P<minutes>15|20|30|45|60|90|120|180|240|360)"
                    r"(?:\s*-\s*(?P<suffix>A|AB|B|M))?\b", re.I)
_SUBJECT = re.compile(
    r"^\s*(?:[A-Z]\d{2,4}[., ]+)?"
    r"(?:(?P<wall>[\w-]*wand|fire[ -]wall)|(?P<ceiling>[\w-]*decke)|(?P<column>[\w-]*stütze))\b",
    re.I,
)
_FIRE_WALL = re.compile(r"\b(?:Brandwand|Brandschutzwand|fire[ -]wall)\b", re.I)
_LABEL = re.compile(r"^\s*(?:Brandschutz(?:klasse)?|Feuerwiderstand(?:sklasse)?)\s*[:=]", re.I)
_CLAUSES = re.compile(r"[;\n]|\.(?=\s+\S)")
_OTHER_COMPONENT = re.compile(r"\b(?:mit\b(?!\s+(?:Feuerwiderstand|Brandschutz))|für|inkl\.?|einschl\.?|"
                              r"einschließlich|Anschluss(?:wand)?|Nachbarwand|Nebenwand|Bestandswand|Bekleidung|Türöffnung|Zarge|"
                              r"[\w-]*tür|Fuge|Dichtung|Unterkonstruktion)\b", re.I)
_QUALIFIED = re.compile(r"\b(?:nicht|kein\w*|höchstens|oder|alternativ|gegebenenfalls|wahlweise|falls|sofern|"
                        r"Bestand|vorhanden|Abbruch|Rückbau|entfernen|ausbauen)\b|\?", re.I)
_REFERENCE = re.compile(r"\b(?:gemäß|nach|laut|siehe)\s+(?:(?:dem|der)\s+)?"
                        r"Brandschutz(?:konzept|plan|nachweis)\b", re.I)
_MINIMUM = re.compile(r"(?:mindestens|min\.|≥|>=)\s*$", re.I)


def _subject(text):
    match = _SUBJECT.match(text)
    return match.lastgroup if match else None


def _ratings(text, component):
    active = True
    for clause in _CLAUSES.split(text.strip()):
        if _OTHER_COMPONENT.match(clause.lstrip()):
            active = False
            continue
        named = _subject(clause)
        if named:
            active = named == component
        if not active:
            continue
        if not (named or _LABEL.match(clause) or _CLASS.fullmatch(clause.strip().rstrip("."))):
            continue
        # Ignore a rating after a component boundary within the leading clause.
        boundary = _OTHER_COMPONENT.search(clause)
        primary = clause[:boundary.start()] if boundary else clause
        for match in _CLASS.finditer(primary):
            yield (match["family"].upper(), int(match["minutes"]), (match["suffix"] or "").upper(),
                   match[0], bool(_MINIMUM.search(primary[:match.start()])),
                   bool(_QUALIFIED.search(OR_EQUIVALENT.sub("", primary))))


def structural_fire_review(heading, detail):
    heading, detail = heading or "", detail or ""
    component = _subject(heading)
    if not component and not _CLASS.fullmatch(heading.strip()):
        return None
    short, long = list(_ratings(heading, component)), list(_ratings(detail, component))
    if not short and not long and component == "wall" and _FIRE_WALL.match(heading.lstrip()):
        if not _QUALIFIED.search(heading) and not _REFERENCE.search(heading + "\n" + detail):
            return "missing", None, None
    a = {item[:3]: item for item in short if not item[-1]}
    b = {item[:3]: item for item in long if not item[-1]}
    if len(a) != 1 or len(b) != 1:
        return None
    left, right = next(iter(a.values())), next(iter(b.values()))
    family, minutes, suffix, quote, minimum, _ = left
    other, other_minutes, other_suffix, other_quote, other_minimum, _ = right
    if family != other:
        return "comparison_unverified", quote, other_quote
    if minutes != other_minutes:
        if minimum and other_minimum or minimum and other_minutes >= minutes or other_minimum and minutes >= other_minutes:
            return None
        return "conflict", quote, other_quote
    if suffix and other_suffix and suffix != other_suffix:
        return "comparison_unverified", quote, other_quote
    return None
