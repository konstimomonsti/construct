"""Conservative, labelled values shared by deterministic text checks."""

from decimal import Decimal
import re

GRADE = re.compile(r"\b(LC|C)\s*(\d{1,3})\s*/\s*(\d{1,3})\b", re.I)
EXPOSURE = re.compile(r"\b(?:XC[1-4]|X[DSA][1-3]|XF[1-4]|XM[1-3]|W[OFAS])\b", re.I)
NUMBER = r"\d+(?:[.,]\d+)?"
MEASURE = rf"({NUMBER})\s*(mm|cm|m)\b"
DIMENSIONS = {
    "length": re.compile(rf"\b(?:l\s*=|Länge\s*[:=]?)\s*(?:ca\.?\s*)?{MEASURE}", re.I),
    "thickness": re.compile(rf"\b(?:d\s*=|Dicke\s*[:=]?|Stärke\s*[:=]?)\s*(?:ca\.?\s*)?{MEASURE}", re.I),
}


def centimetres(number: str, unit: str) -> Decimal:
    return Decimal(number.replace(",", ".")) * {"mm": Decimal("0.1"), "cm": Decimal(1), "m": Decimal(100)}[unit.lower()]


def grades(text: str) -> set[str]:
    return {f"{m[1].upper()}{int(m[2])}/{int(m[3])}" for m in GRADE.finditer(text)}


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
