"""Conservative, labelled values shared by deterministic text checks."""

from decimal import Decimal
import re

GRADE = re.compile(r"\b(LC|C)\s*(\d{1,3})\s*/\s*(\d{1,3})\b", re.I)
# Exposure classes are always written in capitals; matching case-insensitively turns the German word "wo" into WO.
EXPOSURE = re.compile(r"\b(?:XC[1-4]|X[DSA][1-3]|XF[1-4]|XM[1-3]|W[OFAS])\b")
# DIN EN 206 / DIN 1045-2 compressive strength classes (cylinder/cube), weakest first.
NORMAL_GRADES = ("C8/10", "C12/15", "C16/20", "C20/25", "C25/30", "C30/37", "C35/45", "C40/50", "C45/55",
                 "C50/60", "C55/67", "C60/75", "C70/85", "C80/95", "C90/105", "C100/115")
LIGHTWEIGHT_GRADES = ("LC8/9", "LC12/13", "LC16/18", "LC20/22", "LC25/28", "LC30/33", "LC35/38", "LC40/44",
                      "LC45/50", "LC50/55", "LC55/60", "LC60/66", "LC70/77", "LC80/88")
STANDARD_GRADES = frozenset(NORMAL_GRADES + LIGHTWEIGHT_GRADES)
NUMBER = r"\d+(?:[.,]\d+)?"
MEASURE = rf"({NUMBER})\s*(mm|cm|m)\b"
DIMENSIONS = {
    "length": re.compile(rf"\b(?:l\s*=|Länge\s*[:=]?)\s*(?:ca\.?\s*)?{MEASURE}", re.I),
    "thickness": re.compile(rf"\b(?:d\s*=|Dicke\s*[:=]?|Stärke\s*[:=]?)\s*(?:ca\.?\s*)?{MEASURE}", re.I),
}


def centimetres(number: str, unit: str) -> Decimal:
    return Decimal(number.replace(",", ".")) * {"mm": Decimal("0.1"), "cm": Decimal(1), "m": Decimal(100)}[unit.lower()]


def grades(text: str) -> set[str]:
    """Concrete classes in the text. Pairs that can't be a concrete class (e.g. armour stone "C 200/400",
    or a cube strength not above the cylinder strength) are ignored."""
    found = set()
    for m in GRADE.finditer(text):
        grade = f"{m[1].upper()}{int(m[2])}/{int(m[3])}"
        if grade in STANDARD_GRADES or 0 < int(m[2]) <= 100 and int(m[2]) < int(m[3]) <= 2 * int(m[2]):
            found.add(grade)
    return found


def values(text: str) -> dict[str, set[str]]:
    result = {
        "concrete": grades(text),
        "DN": {str(int(x)) for x in re.findall(r"\bDN\s*(\d{2,4})\b", text, re.I)},
        "fire": {f"{a.upper()}{b}" for a, b in re.findall(r"\b(T|EI2?|F)\s*-?\s*(30|60|90|120)\b", text, re.I)},
        "IP": {x.upper().replace(" ", "") for x in re.findall(r"\bIP\s*[0-6X][0-9X]\b", text, re.I)},
        "board": {x.upper() for x in re.findall(r"\b(?:GKBI|GKFI|GKB|GKF)\b", text, re.I)},
    }
    for family, pattern in DIMENSIONS.items():
        result[family] = {str(centimetres(m[1], m[2]).normalize()) for m in pattern.finditer(text)}
    return result

WATER_IMPACT = re.compile(r"\bW\s*[1-4](?:\.[1-2])?\s*-\s*E\b", re.I)
GROUND_CONTACT = re.compile(r"\b(?:erdberührt\w*|erdberuehrt\w*|Erdreich|Bodenkontakt|Spritzwasser\w*)\b", re.I)
PRECAST_PLINTH = re.compile(r"\b(?:FT[ -]Sockel\w*|Sockel\w*|Sandwich\w*|Fertigteil\w*)\b", re.I)
WATERPROOFING = re.compile(r"\b(?:Abdichtung\w*|abdichten|Abdichtungsbahn\w*|waterproofing)\b", re.I)
FIRE_RATING = re.compile(r"\b(REI|F)\s*-?\s*(30|60|90|120)\b", re.I)
FIRE_WALL = re.compile(r"\b(?:Brandwand\w*|Brandschutzwand\w*|fire[ -]wall)\b", re.I)
REBAR_KEYWORD = re.compile(r"\b(?:Betonstahl\w*|Bewehrung\w*|Betonstabstahl\w*)\b", re.I)
REBAR_GRADE = re.compile(r"\b(Bst\s*\d{3}\s*[A-Za-z]*|B\s*\d{3}\s*[A-Za-z]*)\b", re.I)
REBAR_VALID = re.compile(r"(?:B\s*500\s*(?:A|B|NR)|Bst\s*500\s*[SM])", re.I)
TOLERANCE_DEMAND = re.compile(r"\b(?:erhöhte[rmns]?\s+Genauigkeit|erhoehte[rmns]?\s+Genauigkeit|Sondertoleranz\w*)\b", re.I)
TOLERANCE_SPEC = re.compile(r"(?:DIN\s*18202[^.;\n]{0,80}Tab(?:elle)?\.?\s*3[^.;\n]{0,40}(?:Zeile|Z\.)\s*\d+|DIN\s*18203\s*-\s*1[^.;\n]{0,80}Klasse\s*[\w-]+)", re.I)
VOB_OPENING = re.compile(r"\b(?:Aussparung\w*|Öffnung\w*|Oeffnung\w*)\b", re.I)
VOB_DEDUCTION = re.compile(r"\b(?:Abzug|abziehen|abzuziehen|abgezogen)\b", re.I)
VOB_LIMIT = re.compile(r"(?:\b(?:unter|bis|kleiner\s+als|höchstens|max(?:imal)?\.?)\s*|<=?\s*)(\d+(?:[,.]\d+)?)\s*(m²|m2|qm|m³|m3|cbm)(?!\w)", re.I)
