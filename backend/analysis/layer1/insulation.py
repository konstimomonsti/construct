"""Compare written thermal properties only within the same insulation layer."""

from dataclasses import dataclass
from decimal import Decimal
import re

from .common import OR_EQUIVALENT
from .textvalues import NUMBER, centimetres

_MATERIAL = re.compile(r"\b(?:EPS|XPS|PIR|PUR|Mineralwolle|Glaswolle|Steinwolle|Holzfaser)\b", re.I)
_LAYER = re.compile(
    r"^\s*(?:(?:EPS|XPS|PIR|PUR)[ -]+)?(?P<role>Ausgleichsschicht|Gefälledämmung|Trittschalldämmung|"
    r"Perimeterdämmung|Wärmedämmung|Dämm(?:ung|stoff\w*|schicht|platten?))\b", re.I,
)
_GENERIC = {"dämmung", "dämmschicht", "dämmplatte", "dämmplatten", "dämmstoff", "wärmedämmung"}
_CLAUSES = re.compile(r"[;\n]|\.(?=\s+[A-ZÄÖÜẞλ])")
_ACCESSORY = re.compile(r"\b(?:inkl\.?|einschl\.?|einschließlich|mit(?!\s+(?:WLG|WLS|Wärmeleit|Bemessungswert|Nennwert))|Randdämmstreifen|Randdämmung|"
                        r"Rohrdämmung|Dämmkeil|Schüttung|Schutzlage|Estrichdicke)\b", re.I)
_UNCERTAIN = re.compile(r"\b(?:ca\.?|circa|etwa|optional|alternativ|wahlweise|oder|bis|sofern|falls|"
                        r"Bestand|vorhanden|Rückbau|mindestens)\b|[?±]", re.I)
_THICKNESS_BOUND = re.compile(r"\b(?:maximal|max\.|höchstens)\b|[<>≤≥]", re.I)
_MULTI = re.compile(r"\b(?:gesamt|Gesamtdicke|zweilagig|mehrlagig|\d+[ -]lagig)\b|\d\s*[×x/]\s*\d", re.I)
_UPPER_LIMIT = re.compile(r"(?:≤|<=|\bmax\.?|\bhöchstens)\s*$", re.I)
_GRADE = re.compile(r"\b(?P<kind>WLG|WLS|Wärmeleitgruppe|Wärmeleitfähigkeitsstufe)\s*[:=]?\s*(?P<value>0[1-9]\d)\b", re.I)
_LAMBDA = re.compile(
    rf"(?<!\w)(?P<kind>(?:Bemessungswert|Nennwert)(?:\s+der\s+Wärmeleitfähigkeit)?|"
    rf"Wärmeleitfähigkeit|λ(?:[ _]?(?:BW|B|D))?)\s*[:=]?\s*(?P<limit>≤|<=|max\.?|höchstens)?\s*"
    rf"(?P<value>{NUMBER})\s*(?P<power>(?-i:mW|W))\s*/\s*(?:\(\s*m\s*[·∙*]?\s*K\s*\)|m\s*[·∙*]?\s*K)(?!\w)",
    re.I,
)
_THICKNESS_LEAD = re.compile(r"(?:[,;:]|\b(?:Plattendicke|Dicke|d)\s*[:=])\s*$", re.I)
_LENGTH = re.compile(rf"(?<!\w)(?P<value>{NUMBER})\s*(?P<unit>mm|cm)\b", re.I)
_LABELLED_THICKNESS = re.compile(
    rf"^\s*(?:(?:Plattendicke|Dämmdicke|Dämmstoffdicke|Dicke)\s*[:=]\s*|d\s*=\s*)"
    rf"(?P<value>{NUMBER})\s*(?P<unit>mm|cm)\b", re.I,
)


@dataclass(frozen=True)
class WrittenValue:
    value: Decimal
    quote: str
    upper_limit: bool = False


def insulation_role(heading):
    match = _LAYER.match(heading or "")
    if not match or (match["role"].casefold() == "ausgleichsschicht" and not _MATERIAL.search(heading)):
        return None
    return match["role"].casefold()


def _conductivities(text):
    for match in _GRADE.finditer(text):
        if re.match(r"\s*[-–—/]\s*\d", text[match.end():]):
            continue
        kind = match["kind"].casefold()
        basis = "WLS" if kind in {"wls", "wärmeleitfähigkeitsstufe"} else "WLG"
        limit = _UPPER_LIMIT.search(text[:match.start()])
        quote = text[limit.start():match.end()] if limit else match[0]
        yield basis, WrittenValue(Decimal(match["value"]) / 1000, quote, bool(limit))
    for match in _LAMBDA.finditer(text):
        kind = re.sub(r"[ _]", "", match["kind"].casefold())
        basis = ("design" if kind.startswith("bemessungswert") or kind in {"λb", "λbw"} else
                 "declared" if kind.startswith("nennwert") or kind == "λd" else "unspecified")
        number = Decimal(match["value"].replace(",", "."))
        if number > 0:
            limit = _UPPER_LIMIT.search(text[:match.start()])
            quote = text[limit.start():match.end()] if limit else match[0]
            yield basis, WrittenValue(number / (1000 if match["power"] == "mW" else 1),
                                      quote, bool(match["limit"] or limit))


def is_conductivity_quote(text):
    needle = text.strip().rstrip(".,;")
    return any(value.quote == needle for _, value in _conductivities(needle))


def _scoped_clauses(heading, detail, role):
    material = _MATERIAL.search(heading)
    active = True
    for clause in _CLAUSES.split(detail or ""):
        named = _LAYER.match(clause)
        if named:
            family = named["role"].casefold()
            other = _MATERIAL.search(clause)
            active = (family == role or family in _GENERIC or role in _GENERIC) and (
                not material or not other or material[0].casefold() == other[0].casefold())
        boundary = _ACCESSORY.search(clause)
        if boundary and not clause[:boundary.start()].strip():
            active = False
        if active:
            yield clause[:boundary.start()] if boundary else clause


def _unique(entries):
    values = {(item.value, item.upper_limit): item for item in entries}
    return next(iter(values.values())) if len(values) == 1 else None


def _disagrees(a, b):
    if a.upper_limit and b.upper_limit:
        return False
    if a.upper_limit:
        return b.value > a.value
    if b.upper_limit:
        return a.value > b.value
    return a.value != b.value


def insulation_conflicts(heading, detail):
    role = insulation_role(heading)
    if not role or _UNCERTAIN.search(OR_EQUIVALENT.sub("", heading)):
        return
    boundary = _ACCESSORY.search(heading)
    primary = heading[:boundary.start()] if boundary else heading
    clauses = [clause for clause in _scoped_clauses(heading, detail, role)
               if not _UNCERTAIN.search(OR_EQUIVALENT.sub("", clause))]
    short, long = list(_conductivities(primary)), [pair for clause in clauses for pair in _conductivities(clause)]
    for basis in dict.fromkeys(key for key, _ in short):
        a = _unique(item for key, item in short if key == basis)
        b = _unique(item for key, item in long if key == basis)
        if a and b and _disagrees(a, b):
            yield "insulation_conductivity", basis, a, b

    if (role == "gefälledämmung" or _MULTI.search(primary) or _THICKNESS_BOUND.search(primary)
            or any(_MULTI.search(clause) for clause in clauses)):
        return
    short_lengths = list(_LENGTH.finditer(primary))
    long_lengths = [match for clause in clauses if (match := _LABELLED_THICKNESS.match(clause))]
    if len(short_lengths) != 1:
        return
    match = short_lengths[0]
    lead = primary[:match.start()].rstrip()
    leading_role = _LAYER.match(lead)
    if (not _THICKNESS_LEAD.search(lead) and not (leading_role and leading_role.end() == len(lead))
            and not any(material.end() == len(lead) for material in _MATERIAL.finditer(lead))):
        return
    a = WrittenValue(centimetres(match["value"], match["unit"]) * 10, match[0])
    b = _unique(WrittenValue(centimetres(match["value"], match["unit"]) * 10, match[0].strip()) for match in long_lengths)
    if b and a.value > 0 and b.value > 0 and _disagrees(a, b):
        yield "insulation_thickness", "plate", a, b
