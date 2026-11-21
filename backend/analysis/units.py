"""Shared canonical unit vocabulary. Used by the adapter and by every analysis layer."""

from decimal import Decimal
from enum import Enum


class Dimension(str, Enum):
    COUNT = "count"
    LENGTH = "length"
    AREA = "area"
    VOLUME = "volume"
    MASS = "mass"
    TIME = "time"
    LUMP = "lump"
    COMPOSITE = "composite"
    UNKNOWN = "unknown"


# Canonical code -> dimension.
CANONICAL: dict[str, Dimension] = {
    "ea": Dimension.COUNT, "set": Dimension.COUNT,
    "mm": Dimension.LENGTH, "cm": Dimension.LENGTH, "m": Dimension.LENGTH, "km": Dimension.LENGTH,
    "cm²": Dimension.AREA, "m²": Dimension.AREA, "km²": Dimension.AREA,
    "l": Dimension.VOLUME, "m³": Dimension.VOLUME,
    "kg": Dimension.MASS, "t": Dimension.MASS,
    "min": Dimension.TIME, "h": Dimension.TIME, "day": Dimension.TIME, "week": Dimension.TIME,
    "month": Dimension.TIME, "year": Dimension.TIME,
    "lump_sum": Dimension.LUMP,
    "m·week": Dimension.COMPOSITE, "ea·week": Dimension.COMPOSITE, "m²·day": Dimension.COMPOSITE,
    "m²·week": Dimension.COMPOSITE, "m·day": Dimension.COMPOSITE, "ea·day": Dimension.COMPOSITE,
}

# Raw spelling (casefolded, whitespace removed) -> canonical code.
# Superset of importer/tender_import/draft.py::_UNIT_CODES.
_ALIASES: dict[str, str] = {
    "st": "ea", "st.": "ea", "stk": "ea", "stk.": "ea", "stck": "ea", "stück": "ea", "stueck": "ea",
    "pcs": "ea", "pc": "ea", "piece": "ea", "ea": "ea", "nr": "ea", "nr.": "ea",
    "m^2": "m²", "cm^2": "cm²", "km^2": "km²", "m^3": "m³",
    "satz": "set", "set": "set", "garnitur": "set",
    "mm": "mm", "cm": "cm", "m": "m", "lfm": "m", "lfdm": "m", "lfd.m": "m", "km": "km",
    "m2": "m²", "m²": "m²", "qm": "m²", "cm2": "cm²", "cm²": "cm²", "km2": "km²", "km²": "km²",
    "m3": "m³", "m³": "m³", "cbm": "m³", "l": "l", "ltr": "l", "liter": "l",
    "kg": "kg", "t": "t", "to": "t", "to.": "t",
    "min": "min", "std": "h", "std.": "h", "h": "h", "tag": "day", "tage": "day", "d": "day", "td": "day",
    "wo": "week", "woche": "week", "mt": "month", "mt.": "month", "mon": "month", "monat": "month",
    "jahr": "year", "jahre": "year", "jr": "year", "a": "year",
    "psch": "lump_sum", "psch.": "lump_sum", "pschl": "lump_sum", "pausch": "lump_sum",
    "pauschal": "lump_sum", "pau": "lump_sum", "ls": "lump_sum",
    "mwo": "m·week", "stwo": "ea·week", "m2d": "m²·day", "m2wo": "m²·week", "md": "m·day", "sttg": "ea·day",
}


def normalize(raw: str | None) -> str | None:
    """Return the canonical code, the raw text if unknown, or None if empty."""
    if raw is None:
        return None
    cleaned = raw.strip()
    if not cleaned:
        return None
    if cleaned in CANONICAL:
        return cleaned
    key = "".join(cleaned.casefold().split())
    return _ALIASES.get(key, cleaned)


def is_known(unit: str | None) -> bool:
    return unit in CANONICAL


def dimension(unit: str | None) -> Dimension:
    return CANONICAL.get(unit, Dimension.UNKNOWN) if unit else Dimension.UNKNOWN


# Exact factor to the base unit of each dimension (m, m², m³, kg, s, ea). None: no safe conversion
# (calendar months/years, composite units).
FACTORS: dict[str, Decimal | None] = {
    "ea": Decimal(1), "set": Decimal(1),
    "mm": Decimal("0.001"), "cm": Decimal("0.01"), "m": Decimal(1), "km": Decimal(1000),
    "cm²": Decimal("0.0001"), "m²": Decimal(1), "km²": Decimal(1000000),
    "l": Decimal("0.001"), "m³": Decimal(1),
    "kg": Decimal(1), "t": Decimal(1000),
    "min": Decimal(60), "h": Decimal(3600), "day": Decimal(86400), "week": Decimal(604800),
    "month": None, "year": None,
    "lump_sum": Decimal(1),
    "m·week": None, "ea·week": None, "m²·day": None, "m²·week": None, "m·day": None, "ea·day": None,
}
assert FACTORS.keys() == CANONICAL.keys()


def convert(quantity: Decimal, source: str | None, target: str | None) -> Decimal | None:
    """Convert between canonical units of the same dimension. None when it is not safe."""
    if source not in CANONICAL or target not in CANONICAL:
        return None
    if source == target:
        return quantity
    if {source, target} == {"set", "ea"}:  # a set is not one piece
        return None
    if CANONICAL[source] != CANONICAL[target]:
        return None
    source_factor, target_factor = FACTORS[source], FACTORS[target]
    if source_factor is None or target_factor is None:
        return None
    return quantity * source_factor / target_factor
