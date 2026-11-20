"""Shared canonical unit vocabulary. Used by the adapter and by every analysis layer."""

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
    "pcs": "ea", "pc": "ea", "ea": "ea", "nr": "ea", "nr.": "ea",
    "satz": "set", "set": "set", "garnitur": "set",
    "mm": "mm", "cm": "cm", "m": "m", "lfm": "m", "lfdm": "m", "lfd.m": "m", "km": "km",
    "m2": "m²", "m²": "m²", "qm": "m²", "cm2": "cm²", "cm²": "cm²", "km2": "km²", "km²": "km²",
    "m3": "m³", "m³": "m³", "cbm": "m³", "l": "l", "ltr": "l", "liter": "l",
    "kg": "kg", "t": "t", "to": "t", "to.": "t",
    "min": "min", "std": "h", "std.": "h", "h": "h", "tag": "day", "tage": "day", "d": "day", "td": "day",
    "wo": "week", "woche": "week", "mt": "month", "mon": "month", "monat": "month",
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
