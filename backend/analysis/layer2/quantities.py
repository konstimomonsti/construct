"""Unit helpers for layer 2. Everything comes from the shared vocabulary in analysis/units.py."""

from .. import units as shared_units
from ..units import convert  # noqa: F401  re-exported for layer 2 callers

# (dimension, factor to the base unit) per canonical unit, kept for existing callers.
UNITS = {unit: (dim.value, shared_units.FACTORS[unit]) for unit, dim in shared_units.CANONICAL.items()}


def normalize_unit(value: str | None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("A unit must be text or null")
    return shared_units.normalize(value)


def dimension(unit: str | None) -> str:
    return shared_units.dimension(unit).value
