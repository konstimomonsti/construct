"""Attribute a written strength class to explicitly named concrete components."""

from dataclasses import dataclass
import re

from .textvalues import GRADE, MEASURE, grades

_COMPONENT = r"\b(?:Fundament|Bodenplatte|Rückenstütze|Rückenkeil|Bettung|Sauberkeitsschicht)\b"
_COMPONENTS = rf"{_COMPONENT}(?:\s+(?:und\s+)?{_COMPONENT})*"
_BEFORE = re.compile(
    rf"(?P<components>{_COMPONENTS})\s*[:,]?\s*(?:aus\s+)?(?:{MEASURE}\s+)?"
    r"(?:(?:Stahl|Normal|Ort|Leicht)?beton(?:\s+der\s+Festigkeitsklasse)?\s*)?$",
    re.I,
)
_AFTER = re.compile(rf"^\s+für\s+(?:(?:das|die|den)\s+)?(?P<components>{_COMPONENTS})", re.I)
_NAMES = re.compile(_COMPONENT, re.I)
_RELATION = re.compile(
    rf"{_COMPONENT}\s+(?:für|unter|auf|der|des|an)\s+(?:(?:das|den|die|dem|der)\s+)?$", re.I,
)
_ALTERNATIVE = re.compile(r"^\s*(?:\([^()]{1,30}\)\s*)?(?:oder\b|bzw\.|bis\b|wahlweise\b|alternativ\b|je nach\b)", re.I)


@dataclass(frozen=True)
class GradeMention:
    grade: str
    components: frozenset[str]
    quote: str


def mentions(text: str) -> list[GradeMention]:
    result = []
    for grade in GRADE.finditer(text):
        if not (valid := grades(grade[0])):
            continue
        start, end = grade.span()
        prefix_start = max(0, start - 100)
        prefix = text[prefix_start:start]
        suffix = text[end:end + 100]
        anchor = _AFTER.match(suffix)
        preceding = _BEFORE.search(prefix)
        if preceding and _RELATION.search(prefix[:preceding.start()]):
            preceding = None
        if anchor and preceding:
            forward = {name.casefold() for name in _NAMES.findall(anchor["components"])}
            backward = {name.casefold() for name in _NAMES.findall(preceding["components"])}
            if forward != backward:
                anchor = preceding = None
            else:
                anchor = None
        if _ALTERNATIVE.match(suffix):
            anchor = preceding = None
        components = frozenset()
        if match := anchor or preceding:
            components = frozenset(name.casefold() for name in _NAMES.findall(match["components"]))
            if preceding:
                start = prefix_start + preceding.start()
            else:
                end += anchor.end()
        result.append(GradeMention(next(iter(valid)), components, text[start:end]))
    return result


def by_component(items: list[GradeMention]) -> dict[str, list[GradeMention]]:
    result: dict[str, list[GradeMention]] = {}
    for item in items:
        for component in item.components:
            result.setdefault(component, []).append(item)
    return result


def different_components(short: str, detail: str, short_quote: str, detail_quote: str) -> bool:
    """Check the source descriptions when a model quotes competing strength classes."""
    brief, full = grades(short_quote), grades(detail_quote)
    if not brief or not full or brief & full:
        return False
    left = [item for item in mentions(short) if item.grade in brief]
    right = [item for item in mentions(detail) if item.grade in full]
    if not left or not right or not all(item.components for item in left + right):
        return False
    return not (by_component(left).keys() & by_component(right).keys())
