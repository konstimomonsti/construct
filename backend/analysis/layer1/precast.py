"""Sandwich thickness arithmetic and conservative trade/unit checks."""

from decimal import Decimal
import re

from ..registry import rule
from .common import label, text_of
from .textvalues import MEASURE, centimetres

ITEM_TYPES = (
    ("opening_surcharge", r"\bZul(?:age|\.)?\s+.*(?:Aussparung|Öffnung)", ("ea",)),
    ("shop_drawings", r"\b(?:Werkstatt|Montage)[-\s]*(?:zeichnungen|pläne|plaene)\b", ("lump_sum", "h")),
    ("rebar", r"\bBetonstahl\w*", ("t", "kg")),
    ("embedded_part", r"\b(?:Halfen\w*|Ankerschiene\w*|Einbauteil\w*)", ("ea", "m")),
    ("sandwich_plinth", r"\b(?:Sandwich\w*|FT-Sockel\w*)", ("ea", "m²", "m")),
)
LAYERS = {
    "facing_shell_cm": re.compile(rf"\b(?:Dicke\s+)?Vorsatzschale\s*[:=]?\s*{MEASURE}", re.I),
    "structural_shell_cm": re.compile(rf"\b(?:Dicke\s+)?Tragschale\s*[:=]?\s*{MEASURE}", re.I),
    "insulation_cm": re.compile(rf"\bDämmschicht\s*:\s*(?:[^\n;]*?\bd\s*=\s*)?{MEASURE}", re.I),
    "total_thickness_cm": re.compile(rf"\bd\s*=\s*{MEASURE}\s*gesamt\b", re.I),
}


def item_type(text: str) -> tuple[str, tuple[str, ...]] | None:
    for name, pattern, allowed in ITEM_TYPES:
        if re.search(pattern, text, re.I):
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
            found = {centimetres(m[1], m[2]) for m in pattern.finditer(text)}
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
            yield ctx.finding(line=line, field="unit",
                message=f"{label(line)}: {line.unit} is unusual for {name}; expected {', '.join(allowed)}.",
                evidence={"item_type": name, "unit": line.unit, "allowed_units": list(allowed),
                          "bieterfrage_de": f"Zu Pos. {line.code}: Ist die Abrechnung in {line.unit_raw or line.unit} beabsichtigt? Bitte bestätigen Sie die Abrechnungseinheit (üblich: {', '.join(allowed)})."})
