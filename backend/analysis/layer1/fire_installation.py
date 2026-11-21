"""Match a fire-door declaration to the installation it explicitly covers."""

from dataclasses import dataclass
from decimal import Decimal
import re

from ..contracts import ProductDeclaration
from .textvalues import NUMBER, centimetres

SUPPORT = "fire_door_supporting_construction"
MIN_THICKNESS = "fire_door_min_wall_thickness"
_FIELD = re.compile(r"^\s*(?P<label>Wandmaterial|Wandart|Wanddicke|Wandstärke)\s*[:=]\s*(?P<value>.*?)\s*$", re.I)
_CLAUSES = re.compile(r"[\r\n;]|\.(?=\s+[A-ZÄÖÜ])")
_MEASURE = re.compile(rf"(?P<number>{NUMBER})\s*(?P<unit>mm|cm|m)", re.I)
_INDEFINITE = re.compile(r"\b(?:oder|alternativ|wahlweise|bzw|offen|ungeklärt|unbekannt|TBD|nicht angegeben|wie vor|siehe)\b|[/?]", re.I)
_DASHES = re.compile(r"\s*[-–—]\s*")


def _support(value, unit=None):
    if unit or not isinstance(value, str) or _INDEFINITE.search(value):
        return None
    text = _DASHES.sub("-", " ".join(value.casefold().split()))
    return text if any(character.isalpha() for character in text) else None


def _wall_mm(value):
    match = _MEASURE.fullmatch(value)
    if match and (number := centimetres(match["number"], match["unit"]) * 10) > 0:
        return number
    return None


def _one_value(values):
    return next(iter(values)) if len(values) == 1 else None


@dataclass(frozen=True)
class TenderWall:
    construction: str | None
    thickness_mm: Decimal | None
    support_quotes: tuple[str, ...]
    thickness_quotes: tuple[str, ...]

    def evidence(self):
        return {
            "supporting_construction": self.construction,
            "wall_thickness_mm": self.thickness_mm,
            "support_quotes": list(self.support_quotes),
            "thickness_quotes": list(self.thickness_quotes),
        }


def _tender_wall(heading, detail):
    supports, thicknesses = {}, {}
    for text in (heading, detail):
        for clause in _CLAUSES.split(text or ""):
            match = _FIELD.fullmatch(clause.strip().rstrip("."))
            if not match:
                continue
            if match["label"].casefold() in {"wandmaterial", "wandart"}:
                supports[match[0]] = _support(match["value"])
            else:
                thicknesses[match[0]] = _wall_mm(match["value"])
    return TenderWall(_one_value(set(supports.values())), _one_value(set(thicknesses.values())),
                      tuple(supports), tuple(thicknesses))


@dataclass
class InstallationMatch:
    declarations: list[ProductDeclaration]
    evidence: dict | None = None
    reason: str | None = None


def _minimum_thickness(declaration):
    prop = declaration.properties.get(MIN_THICKNESS)
    return _wall_mm(f"{prop.value} {prop.unit}") if prop and prop.unit else None


def _declared_support(declaration):
    prop = declaration.properties.get(SUPPORT)
    return _support(prop.value, prop.unit) if prop else None


def match_installation(heading, detail, declarations, class_property):
    """Keep class and installation conditions from the same declaration record."""
    wall = _tender_wall(heading, detail)
    scoped = any({SUPPORT, MIN_THICKNESS} & item.properties.keys() for item in declarations)
    if not wall.support_quotes and not wall.thickness_quotes and not scoped:
        return InstallationMatch(declarations)
    evidence = wall.evidence()
    evidence["declared_supporting_constructions"] = sorted({
        support for item in declarations if class_property in item.properties and (support := _declared_support(item))
    })
    if wall.construction is None:
        return InstallationMatch(declarations, evidence, "fire_wall_scope_unverified")
    matching = [item for item in declarations if class_property in item.properties
                and _declared_support(item) == wall.construction]
    if not matching:
        return InstallationMatch(declarations, evidence, "fire_wall_scope_unverified")

    minimums = [(item, _minimum_thickness(item)) for item in matching]
    evidence["declared_minimum_thicknesses_mm"] = sorted({minimum for _, minimum in minimums if minimum is not None})
    if not wall.thickness_quotes and all(MIN_THICKNESS not in item.properties for item in matching):
        return InstallationMatch(matching, evidence)
    if wall.thickness_mm is None:
        return InstallationMatch(matching, evidence, "fire_wall_thickness_unverified")
    applicable = [item for item, minimum in minimums if minimum is not None and wall.thickness_mm >= minimum]
    if applicable:
        return InstallationMatch(applicable, evidence)
    if all(minimum is not None for _, minimum in minimums):
        return InstallationMatch(matching, evidence, "fire_wall_below_minimum")
    return InstallationMatch(matching, evidence, "fire_wall_thickness_unverified")
