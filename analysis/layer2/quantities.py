"""Canonical contract units, with exact conversions inside each dimension."""

from decimal import Decimal

from .. import units as shared_units

# (dimension, multiplier to the base unit for that dimension)
UNITS = {
    "ea": ("count", Decimal("1")),
    "set": ("count", Decimal("1")),
    "mm": ("length", Decimal("0.001")),
    "cm": ("length", Decimal("0.01")),
    "m": ("length", Decimal("1")),
    "km": ("length", Decimal("1000")),
    "m²": ("area", Decimal("1")),
    "cm²": ("area", Decimal("0.0001")),
    "km²": ("area", Decimal("1000000")),
    "m³": ("volume", Decimal("1")),
    "l": ("volume", Decimal("0.001")),
    "kg": ("mass", Decimal("1")),
    "t": ("mass", Decimal("1000")),
    "min": ("time", Decimal("60")),
    "h": ("time", Decimal("3600")),
    "day": ("time", Decimal("86400")),
    "week": ("time", Decimal("604800")),
    "month": ("time", None),
    "year": ("time", None),
    "lump_sum": ("lump", Decimal("1")),
    "m·week": ("composite", None),
    "ea·week": ("composite", None),
    "m²·day": ("composite", None),
    "m²·week": ("composite", None),
    "m·day": ("composite", None),
    "ea·day": ("composite", None),
}

ALIASES = {u.casefold(): u for u in UNITS}
ALIASES.update({
    "stk": "ea", "stk.": "ea", "st": "ea", "st.": "ea", "stück": "ea",
    "stueck": "ea", "pcs": "ea", "piece": "ea", "m2": "m²", "m^2": "m²",
    "qm": "m²", "cm2": "cm²", "cm^2": "cm²", "km2": "km²", "km^2": "km²",
    "m3": "m³", "m^3": "m³", "cbm": "m³", "lfm": "m", "lfdm": "m",
    "ltr": "l", "liter": "l", "std": "h", "std.": "h", "tage": "day",
    "psch": "lump_sum", "psch.": "lump_sum", "pauschal": "lump_sum",
})


def normalize_unit(value: str | None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("A unit must be text or null")
    if not value.strip():
        return None
    value = " ".join(value.split())
    return ALIASES.get(value.casefold(), shared_units.normalize(value))


def dimension(unit: str | None) -> str:
    return shared_units.dimension(unit).value


def convert(quantity: Decimal, source: str | None, target: str) -> Decimal | None:
    """Return None when the units cannot be compared safely."""
    if source not in UNITS or target not in UNITS:
        return None
    if source == target:
        return quantity
    # A set is not a single item; composite/calendar units need more context.
    if {source, target} == {"set", "ea"}:
        return None
    src_dim, src_factor = UNITS[source]
    dst_dim, dst_factor = UNITS[target]
    if src_dim != dst_dim or src_factor is None or dst_factor is None:
        return None
    return quantity * src_factor / dst_factor
