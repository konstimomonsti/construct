"""Explicit specification defects, without semantic guessing or an LLM."""

import re

from ..registry import rule
from .common import BIDDER_INPUT, OR_EQUIVALENT, excerpt, label, text_of
from .textvalues import DIMENSIONS, GRADE, NUMBER, values

# Product/value redactions, not anonymized people or addresses.
PLACEHOLDER = re.compile(r"\[(?:FIRMA|KENNZEICHEN|PRODUKT|TYP|NUMMER)_\d+\]|\bXXX\b|:\s*[-–—]{2,}|"
                         r"\b(?:Fabrikat|Typ|Widerstandsklasse|Produkt)\s*:\s*(?:\.{3,}|…{2,})", re.I)
BIDDER_LABEL = re.compile(r"\b(?:Bieter|angeboten\w*|gewählt\w*|einzutragen|anzugeben)\b", re.I)
UNCLEAR = re.compile(rf"\b(?:[dlbh]\s*=|(?:Dicke|Länge|Breite|Höhe)\s*[:=])\s*"
                     rf"(?:\?[^\n;,]*|{NUMBER}\s*(?:mm|cm|m)?\s*\?|"
                     rf"{NUMBER}\s*(?:mm|cm|m)?\s*(?:/|oder)\s*{NUMBER}\s*(?:mm|cm|m)\b)", re.I)
REFERENCE = re.compile(r"\b(?:siehe\s+(?:auch\s+)?|wie\s+)?Pos(?:ition)?\.?\s*(\d+(?:\s*\.\s*\d+)+)", re.I)
PREVIOUS = re.compile(r"\bwie\s+(?:vor\b|vorstehend\w*|Position\s+zuletzt\b)", re.I)
SIZE = re.compile(rf"\b{NUMBER}\s*(?:mm|cm|m)?\s*[x×/]\s*{NUMBER}\s*(?:mm|cm|m)\b", re.I)
SKIP_ATTRIBUTE = re.compile(r"\b(?:abbruch\w*|abbrechen|demont\w*|ausbauen|rückbau\w*|entfernen|"
                            r"zulage\w*|zul\.|messung\w*|\w*prüfung\w*|repar\w*|markieren|anbohren|dämmstoffdübel\w*)", re.I)
INCLUDED_CLAUSE = re.compile(r"\b(?:einschlie(?:ß|ss)lich|einschl\.|inkl\.|inklusive|zuzüglich|sowie)\b[^.;\n]*", re.I)
FAMILY_DE = {"concrete": "Betonfestigkeitsklasse", "DN": "Nennweite", "fire": "Feuerwiderstand",
             "IP": "IP-Schutzart", "board": "Plattentyp", "length": "Länge in cm", "thickness": "Dicke in cm"}
ATTRIBUTE_DE = {"DN or size": "Nennweite bzw. Abmessung", "cable cross-section": "Kabelquerschnitt",
                "concrete class": "Betonfestigkeitsklasse", "thickness": "Dicke", "door size": "Türabmessung"}


@rule("L1.TEXT.SPEC_PLACEHOLDER", layer=1, category="text", severity="warning",
      title="Specification contains a placeholder", description="Redacted identifiers, XXX or unfilled specification values; explicit bidder input fields are excluded.")
def spec_placeholder(ctx):
    for line in ctx.input.lines:
        text = text_of(line)
        matches = []
        for match in PLACEHOLDER.finditer(text):
            start = text.rfind("\n", 0, match.start()) + 1
            end = text.find("\n", match.end())
            row = text[start:end if end >= 0 else len(text)]
            # Redactions remain defects even next to a bidder field.
            if not match[0].startswith("[") and (BIDDER_LABEL.search(row) or OR_EQUIVALENT.search(row)):
                continue
            if BIDDER_INPUT.fullmatch(match[0].strip()):
                continue
            matches.append(excerpt(text, match))
        if matches:
            yield ctx.finding(line=line, field="long_text",
                message=f"{label(line)} contains unresolved specification placeholders: {matches[0]}",
                evidence={"kind": "placeholder", "excerpts": matches,
                          "bieterfrage_de": f"Zu Pos. {line.code}: Der Ausschreibungstext enthält unvollständige Angaben ({matches[0]}). Bitte stellen Sie das genaue Fabrikat, den Typ bzw. den Wert klar."})


@rule("L1.TEXT.UNCLEAR_DIMENSION", layer=1, category="text", severity="warning",
      title="Dimension is unclear", description="Question marks or competing numeric values in an explicitly labelled dimension.")
def unclear_dimension(ctx):
    for line in ctx.input.lines:
        matches = [m[0] for m in UNCLEAR.finditer(text_of(line))]
        if matches:
            yield ctx.finding(line=line, field="long_text",
                message=f"{label(line)} contains unclear dimensions: {', '.join(matches)}.",
                evidence={"dimensions": matches,
                          "bieterfrage_de": f"Zu Pos. {line.code}: Bitte bestätigen Sie die maßgebenden Abmessungen für die unklaren Angaben ({', '.join(matches)})."})


@rule("L1.TEXT.VALUE_CONFLICT", layer=1, category="text", severity="warning",
      title="Short and long text disagree", description="Disjoint values in DN, concrete, fire, IP, board, labelled length or thickness; DN is informational.")
def value_conflict(ctx):
    for line in ctx.input.lines:
        # Values inside "einschließlich …" clauses belong to an included component (a blinding layer, an edge
        # strip), not to the item the short text names.
        short, long = values(line.short_text or ""), values(INCLUDED_CLAUSE.sub(" ", line.long_text or ""))
        for family in short:
            if short[family] and long[family] and short[family].isdisjoint(long[family]):
                yield ctx.finding(line=line, field="long_text", discriminator=family,
                    severity="info" if family == "DN" else "warning",
                    message=f"{label(line)}: {family} values differ between short and long text.",
                    evidence={"family": family, "short_values": sorted(short[family]), "long_values": sorted(long[family]),
                              "bieterfrage_de": f"Zu Pos. {line.code}: Kurz- und Langtext enthalten unterschiedliche Angaben ({FAMILY_DE[family]}: {', '.join(sorted(short[family]))} / {', '.join(sorted(long[family]))}). Bitte bestätigen Sie die maßgebende Ausführung."})


def code_key(code: str) -> tuple[str, ...]:
    return tuple(str(int(part)) if part.strip().isdigit() else part.strip() for part in code.strip(". ").split("."))


def ordered_lines(ctx):
    return sorted(ctx.input.lines, key=lambda line: line.sort_order)


def refers_to_previous(line) -> bool:
    # References inside a long component list can refer within the same item.
    return bool(PREVIOUS.search(line.short_text or "") or PREVIOUS.match((line.long_text or "").lstrip()))


@rule("L1.TEXT.REFERENCE_UNRESOLVED", layer=1, category="text", severity="warning",
      title="Item reference cannot be resolved", description="Missing or self-referencing OZ codes and previous-item references without a preceding base in the same section.")
def reference_unresolved(ctx):
    codes = {code_key(line.code) for line in ctx.input.lines if line.code}
    bases = {}
    for line in ordered_lines(ctx):
        text = text_of(line)
        unresolved = sorted({m[1] for m in REFERENCE.finditer(text)
                             if code_key(m[1]) not in codes or code_key(m[1]) == code_key(line.code or "")})
        if refers_to_previous(line):
            if line.section_id not in bases:
                unresolved.append("wie vor")
        else:
            bases[line.section_id] = line
        if unresolved:
            yield ctx.finding(line=line, field="long_text",
                message=f"{label(line)} has unresolved references: {', '.join(unresolved)}.",
                evidence={"references": unresolved,
                          "bieterfrage_de": f"Zu Pos. {line.code}: Bitte klären Sie die Verweise ({', '.join(unresolved)}) und stellen Sie die zugehörige Leistungsbeschreibung bereit."})


# Classify the item itself, not materials mentioned in its long description.
ATTRIBUTES = (
    (r"^(?:[\w-]*rohr(?:leitung)?|Trinkwasserleitung|Abwasserleitung)\b", "DN or size",
     lambda text: bool(re.search(r"\b(?:DN(?:/OD)?|AD|DA|Außendurchmesser)\s*\d+\b", text, re.I) or SIZE.search(text) or re.search(rf"[Øø]\s*{NUMBER}", text))),
    (r"^(?:[\w-]*kabel|Mantelleitung|Installationsleitung)\b", "cable cross-section",
     lambda text: bool(re.search(rf"{NUMBER}\s*(?:mm²|mm2)\b|\b\d+\s*[x×G]\s*{NUMBER}", text, re.I))),
    (r"^Ortbeton\w*\b", "concrete class", lambda text: bool(GRADE.search(text))),
    (r"^(?:\w*estrich|Dämmung|Wärmedämmung|Trittschalldämmung|Wärmedämmplatten)\b", "thickness",
     lambda text: bool(DIMENSIONS["thickness"].search(text) or re.search(rf"\b{NUMBER}\s*(?:mm|cm)\b", text, re.I))),
    (r"^(?:Tür|Stahltür|Holztür|Brandschutztür|Feuerschutztür)\b", "door size", lambda text: bool(SIZE.search(text))),
)


@rule("L1.TEXT.SPEC_ATTRIBUTE_MISSING", layer=1, category="text", severity="info",
      title="Basic item attribute missing", description="Conservative checks for pipe/door size, cable cross-section, in-situ concrete class and screed/insulation thickness, including previous-item inheritance.")
def spec_attribute_missing(ctx):
    sections = ctx.input.section_by_id()
    bases = {}
    for line in ordered_lines(ctx):
        text = text_of(line)
        identity = line.short_text or line.long_text or ""
        if refers_to_previous(line) and line.section_id in bases:
            base = bases[line.section_id]
            text += "\n" + text_of(base)
            identity = (base.short_text or "") + "\n" + identity
        elif not refers_to_previous(line):
            bases[line.section_id] = line
        section = sections.get(line.section_id)
        if section:
            text += "\n" + (section.title or "")
        if SKIP_ATTRIBUTE.search(identity):
            continue
        for pattern, attribute, present in ATTRIBUTES:
            if re.search(pattern, identity, re.I) and not present(text):
                yield ctx.finding(line=line, field="long_text", discriminator=attribute,
                    message=f"{label(line)}: no {attribute} found in the item or inherited description.",
                    evidence={"missing_attribute": attribute,
                              "bieterfrage_de": f"Zu Pos. {line.code}: Für die Kalkulation fehlen Angaben ({ATTRIBUTE_DE[attribute]}). Bitte ergänzen Sie die Spezifikation bzw. stellen Sie die zugehörigen Pläne bereit."})
                break
