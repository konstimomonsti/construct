"""Compare written conductor designations for the cable sold by the position."""

from dataclasses import dataclass
from decimal import Decimal
import re

from .common import OR_EQUIVALENT
from .textvalues import NUMBER

# Restrict the notation to named cable families. Similar arithmetic appears in
# accessories, dimensions, quantities and manufacturer codes.
_CABLE = re.compile(
    rf"^\s*(?:(?:[a-zäöüß-]*kabel|[a-zäöüß-]*mantelleitung|Installationsleitung)\s*[:=]?\s*)?"
    rf"(?:Kabeltyp\s*[:=]\s*)?"
    rf"(?P<quote>(?P<family>NYCWY|N2XCY|NYCY|NAYY|NYY|NYM|NHXH|N2XH|H07RN-F)"
    rf"(?:[ -](?P<variant>[JO]))?\s+(?P<cores>[1-9]\d?)\s*[x×G]\s*(?P<section>{NUMBER})"
    rf"(?:\s+(?:RE|RM|SE|SM))?(?:\s*/\s*(?P<concentric>{NUMBER})(?:\s+(?:RE|RM|SE|SM))?)?"
    rf"(?:\s*mm(?:²|\^?2))?)(?![\w²³,.]\d|[\w²³])",
    re.I,
)
_CONCENTRIC_FAMILIES = {"NYCWY", "NYCY", "N2XCY"}
_CLAUSES = re.compile(r"(?<=[.;!?])\s+|[\r\n]")
_CONDITIONAL = re.compile(r"\b(?:oder|bzw|wahlweise|alternativ|optional|gegebenenfalls|sofern|"
                          r"falls|beispielsweise|Bestand|vorhanden|Rückbau|ausbauen)\b", re.I)
_TRAILING_VALUE = re.compile(r"^\s*(?:[/+×]|(?:[,.]\d)|(?:x|mm|cm|m|und|bis|für)\b)", re.I)


@dataclass(frozen=True)
class CableDesignation:
    family: str
    variant: str | None
    cores: int
    section: Decimal
    concentric: Decimal | None
    quote: str

    def values(self):
        return {"cores": self.cores, "core_section_mm2": self.section, "concentric_section_mm2": self.concentric,
                "variant": self.variant}


def cable_designation(text):
    """Return a single designation from the description's leading work clause."""
    parts = [part.strip() for part in _CLAUSES.split(text or "") if part.strip()]
    if not parts:
        return None
    first = parts[0]
    match = _CABLE.match(first)
    if (not match or _CONDITIONAL.search(OR_EQUIVALENT.sub("", first))
            or _TRAILING_VALUE.match(first[match.end():])
            or any(_CABLE.match(part) for part in parts[1:])):
        return None
    family = match["family"].upper()
    if match["concentric"] and family not in _CONCENTRIC_FAMILIES:
        return None
    section = Decimal(match["section"].replace(",", "."))
    concentric = Decimal(match["concentric"].replace(",", ".")) if match["concentric"] else None
    if section <= 0 or concentric is not None and concentric <= 0:
        return None
    return CableDesignation(family, match["variant"].upper() if match["variant"] else None,
                            int(match["cores"]), section, concentric, match["quote"])


def cable_conflict(heading, detail):
    brief, full = cable_designation(heading), cable_designation(detail)
    if not brief or not full or brief.family != full.family:
        return None
    detail_values = full.values()
    differences = [name for name, brief_value in brief.values().items()
                   if brief_value is not None and (detail_value := detail_values[name]) is not None
                   and brief_value != detail_value]
    return (brief, full, differences) if differences else None
