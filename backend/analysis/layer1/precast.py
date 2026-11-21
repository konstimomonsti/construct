"""Sandwich thickness arithmetic and conservative trade/unit checks."""

from decimal import Decimal
import re

from ..registry import rule
from ..units import normalize
from .common import label, text_of
from .textvalues import MEASURE, centimetres

ITEM_TYPES = (
    ("opening_surcharge", r"\bZul(?:age|\.)?\s+.*(?:Aussparung|Öffnung)", ("ea",)),
    ("shop_drawings", r"\b(?:Werkstatt|Montage)[-\s]*(?:zeichnungen|pläne|plaene)\b", ("lump_sum", "h")),
    ("rebar", r"\bBetonstahl\w*", ("t", "kg")),
    ("embedded_part", r"\b(?:Halfen\w*|Ankerschiene\w*|Einbauteil\w*)", ("ea", "m")),
    ("sandwich_plinth", r"\b(?:Sandwich\w*|FT-Sockel\w*)", ("ea", "m²", "m")),
)
ITEM_NAMES = {
    "opening_surcharge": "Zulage für Aussparungen/Öffnungen",
    "shop_drawings": "Werkstatt- und Montagepläne",
    "rebar": "Betonstahl",
    "embedded_part": "Einbauteile/Ankerschienen",
    "sandwich_plinth": "Sandwichsockel/Fertigteil",
}


def tender_unit(unit: str, raw: str | None = None) -> str:
    if unit == "ea":
        return "St"
    if unit == "lump_sum":
        return "psch"
    if unit in {"m²", "m³"}:
        if raw and normalize(raw) == unit and any(ch in raw for ch in "23"):
            return unit.replace("²", "2").replace("³", "3")
        return unit
    return raw if raw and normalize(raw) == unit else unit


LAYERS = {
    "facing_shell_cm": re.compile(rf"\b(?:Dicke\s+)?Vorsatzschale\s*[:=]?\s*{MEASURE}", re.I),
    "structural_shell_cm": re.compile(rf"\b(?:Dicke\s+)?Tragschale\s*[:=]?\s*{MEASURE}", re.I),
    "insulation_cm": re.compile(
        rf"\b(?:Dämmschicht|Dämmstoffdicke|Dämmstärke|Dicke\s+Dämmung)\s*:?\s*(?:[^\n;]*?\bd\s*=\s*)?{MEASURE}", re.I),
    "total_thickness_cm": re.compile(
        rf"\bd\s*=\s*{MEASURE}\s*gesamt\b|\b(?:Gesamtdicke|Gesamtstärke|Elementdicke)\s*:?\s*(?:d\s*=\s*)?{MEASURE}", re.I),
}


# The item noun leads the short text ("Halfen …", "FS 01: FT-Sockel …"); a later mention such as
# "Abdeckarbeiten, Böden und Einbauteile schützen" describes protective work, not an embedded part.
ELEMENT_PREFIX = re.compile(r"^\s*[A-Z]{1,4}\s*\d+\s*:\s*")
LEAD_CHARS = 16


def item_type(text: str) -> tuple[str, tuple[str, ...]] | None:
    head = ELEMENT_PREFIX.sub("", text)
    for name, pattern, allowed in ITEM_TYPES:
        match = re.search(pattern, head, re.I)
        if match and match.start() <= LEAD_CHARS:
            return name, allowed
    return None


@rule("L1.PRECAST.LAYER_SUM", layer=1, category="arithmetic", severity="error",
      title="Sandwich layers do not add up", description="Facing shell plus insulation plus structural shell must equal total thickness within 0.1 cm.")
def layer_sum(ctx):
    for line in ctx.input.lines:
        text = text_of(line)
        if not re.search(r"\b(?:Sandwich\w*|FT-Sockel\w*)", text, re.I):
            continue
        layers = {}
        for name, pattern in LAYERS.items():
            found = {centimetres(*[g for g in m.groups() if g][:2]) for m in pattern.finditer(text)}
            if len(found) == 1:
                layers[name] = found.pop()
        if len(layers) != 4:
            continue
        total = layers["facing_shell_cm"] + layers["insulation_cm"] + layers["structural_shell_cm"]
        if abs(total - layers["total_thickness_cm"]) > Decimal("0.1"):
            yield ctx.finding(line=line, field="long_text",
                message=f"{label(line)}: layers total {total} cm, stated total {layers['total_thickness_cm']} cm.",
                evidence={"layers": layers, "sum_cm": total, "tolerance_cm": "0.1",
                          "bieterfrage_de": f"Zu Pos. {line.code}: Die Schichtdicken ergeben {total} cm und weichen von der Gesamtdicke ab. Bitte bestätigen Sie den maßgebenden Schichtaufbau."})


@rule("L1.UNIT.TRADE_MISMATCH", layer=1, category="unit", severity="warning",
      title="Unit unusual for this item type", description="Checks precast elements, rebar, opening surcharges, embedded parts and shop drawings against the supplied unit table.")
def trade_mismatch(ctx):
    for line in ctx.input.lines:
        classified = item_type(line.short_text or line.long_text or "")
        if not classified or not line.unit:
            continue
        name, allowed = classified
        if line.unit not in allowed:
            actual = tender_unit(line.unit, line.unit_raw)
            expected = ", ".join(tender_unit(unit, line.unit_raw) for unit in allowed)
            yield ctx.finding(line=line, field="unit",
                message=f"{label(line)}: {actual} is unusual for {ITEM_NAMES[name]}; expected {expected}.",
                evidence={"item_type": name, "unit": line.unit, "allowed_units": list(allowed),
                          "bieterfrage_de": f"Zu Pos. {line.code}: Ist die Abrechnung der {ITEM_NAMES[name]} in {actual} beabsichtigt? Bitte bestätigen Sie die Abrechnungseinheit (üblich: {expected})."})
