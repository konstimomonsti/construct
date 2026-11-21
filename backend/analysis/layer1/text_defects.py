"""Explicit specification defects, without semantic guessing or an LLM."""

import re

from ..registry import rule
from .common import BIDDER_INPUT, OR_EQUIVALENT, excerpt, label, review_fix, source_detail, text_of
from .concrete_scope import by_component, mentions
from .textvalues import DIMENSIONS, GRADE, MEASURE, NUMBER, centimetres, grades, values

# Product/value redactions, not anonymized people or addresses.
PLACEHOLDER = re.compile(r"\[(?:FIRMA|KENNZEICHEN|PRODUKT|TYP|NUMMER)_\d+\]|\bXXX\b|:\s*[-–—]{2,}|"
                         r"\b(?:Fabrikat|Typ|Widerstandsklasse|Produkt)\s*:\s*(?:\.{3,}|…{2,})|"
                         r"\b(?:Feuerwiderstand(?:sklasse)?|Brandschutz(?:klasse)?)[ \t]*[:=][ \t]*(?:noch[ \t]+offen|noch[ \t]+festzulegen|TBD)"
                         r"(?=[ \t]*(?:[.;]|\n|$))", re.I)
FIRM_MASK = re.compile(r"\[FIRMA_\d+\]", re.I)
EXAMPLE_SUPPLIER = re.compile(r"\b(?:z\.\s*(?:b\.)?|zum\s+Beispiel)\s+[^.;!?]{0,75}$", re.I)
SUPPLIER_LABEL = re.compile(r"\b(?:Hersteller|Lieferant|Fabrikat)\s*:\s*$", re.I)
SUPPLIER_CONTACT = re.compile(
    r"^\s*(?:[,&]\s*Co\.\s*KG\b|GmbH\b|\[(?:ADRESSE|ORT|TELEFON)_\d+\]|\d{5}\s+[^\W\d_]|Tel\.?:?\s|Fon\s)", re.I,
)
SUPPLIER_ALTERNATIVE = re.compile(r"\boder\s+(?:ein\s+Produkt\s+)?gleichwertig\w*|\bo\.\s*ä\.", re.I)
NEXT_FIELD = re.compile(r"\b(?:Typ|Produkt|Fabrikat|Hersteller|Lieferant)\s*:|\bangeboten\w*\b|[;!?)]", re.I)
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


# Link the height directly to the leading item name. A height later in a list of
# posts, footings or other components cannot resolve which object it describes.
HEIGHT_LABEL = r"(?:h\s*=|Höhe\s*[:=]?)"
ITEM_HEIGHT = re.compile(
    rf"^\s*(?:(?:mobil|provisorisch|temporär|fest|stationär)(?:er|en|es|e)?\s+)*"
    rf"(?P<subject>Bauzaun|Mobilzaun|Schutzzaun|Geländer|Absturzgeländer|Schutzwand|"
    rf"Fassadengerüst|Fertigteilwand|Fertigteilstütze)\b[,\s]+"
    rf"(?P<quote>{HEIGHT_LABEL}\s*(?P<number>{NUMBER})\s*(?P<unit>mm|cm|m))"
    rf"(?![\w²³])", re.I,
)
DIMENSION_ALTERNATIVE = re.compile(
    rf"^[,\s]*(?:bis\b|oder\b|bzw\.|wahlweise\b|alternativ\b|[–—/+±-]|und\s+{NUMBER})", re.I,
)

OTHER_HEIGHT = re.compile(rf"\b{HEIGHT_LABEL}\s*(?:ca\.?\s*)?{MEASURE}", re.I)
DIMENSION_SCOPE_QUALIFIER = re.compile(r"\b(?:je nach|wahlweise|alternativ|in (?:Bereich|Abschnitt))\b", re.I)

WALL = r"(?:GK[\s-]?Ständerwand|Gipskartonständerwand|Metallständerwand)"
SINGLE_BOARD_MEASURE = rf"(?P<number>{NUMBER})\s*(?P<unit>mm|cm)(?![\w²³])"
SHORT_BOARD = re.compile(rf"^\s*{WALL}\b[,\s]+(?P<quote>{SINGLE_BOARD_MEASURE}\s+beplankt)\b", re.I)
DETAIL_BOARD = re.compile(
    rf"^\s*{WALL}\b[^.;]{{0,110}}?\b(?:beplankt|Beplankung)\s+(?:mit|aus)\s+"
    rf"(?:Gipskartonplatten|Gipsplatten|GK-Platten)\b(?:\s+Typ\s+[\w-]+)?[,\s]+"
    rf"(?P<quote>(?:d\s*=|Dicke\s*[:=]?)\s*{SINGLE_BOARD_MEASURE})", re.I,
)
OTHER_BOARD_MEASURE = re.compile(rf"\b(?:d\s*=|Dicke\s*[:=]?)\s*{MEASURE}", re.I)
COMPOSITE_BOARD = re.compile(r"\b(?:mehrlagig|doppellagig|zweilagig|dreilagig|[2-9][ -]?lagig|nicht|ohne)\w*\b|"
                             r"\d+\s*[x×]\s*\d", re.I)


def item_height(text: str | None) -> re.Match | None:
    text = text or ""
    match = ITEM_HEIGHT.match(text)
    if not match:
        return None
    remainder = text[match.end():]
    if DIMENSION_ALTERNATIVE.match(remainder) or OTHER_HEIGHT.search(remainder) or DIMENSION_SCOPE_QUALIFIER.search(remainder):
        return None
    return match


def attributed_dimensions(short_text: str | None, detail: str | None):
    heading, body = short_text or "", detail or ""
    short_height, long_height = item_height(heading), item_height(body)
    if short_height and long_height and short_height["subject"].casefold() == long_height["subject"].casefold():
        yield "height", f"Höhe für {short_height['subject']}", short_height, long_height

    short_board, long_board = SHORT_BOARD.match(heading), DETAIL_BOARD.match(body)
    if (short_board and long_board and not COMPOSITE_BOARD.search(heading + "\n" + body)
            and not DIMENSION_ALTERNATIVE.match(heading[short_board.end():])
            and not DIMENSION_ALTERNATIVE.match(body[long_board.end():])
            and not OTHER_BOARD_MEASURE.search(body[long_board.end():])
            and not DIMENSION_SCOPE_QUALIFIER.search(body[long_board.end():])):
        yield "board_thickness", "Dicke der Gipsplattenbeplankung", short_board, long_board


def supplier_reference(text: str, match: re.Match) -> bool:
    """Check if a masked company occurs in an example, alternative, or contact block."""
    if not FIRM_MASK.fullmatch(match[0]):
        return False
    before = text[max(0, match.start() - 95):match.start()]
    after = text[match.end():match.end() + 100]
    alternative = NEXT_FIELD.split(after, maxsplit=1)[0]
    return bool(EXAMPLE_SUPPLIER.search(before) or SUPPLIER_ALTERNATIVE.search(alternative)
                or SUPPLIER_LABEL.search(before) and SUPPLIER_CONTACT.match(after))


@rule("L1.TEXT.SPEC_PLACEHOLDER", layer=1, category="text", severity="warning",
      title="Specification contains a placeholder",
      description="Unresolved identifiers, XXX or unfilled technical values. Excludes bidder fields and masked example suppliers or contacts.")
def spec_placeholder(ctx):
    for line in ctx.input.lines:
        text = text_of(line)
        matches = []
        for match in PLACEHOLDER.finditer(text):
            if supplier_reference(text, match):
                continue
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


def _concrete_conflicts(ctx, line, detail):
    short = line.short_text or ""
    brief, full = mentions(short), mentions(detail)
    if not brief or not full:
        return
    left, right = by_component(brief), by_component(full)
    findings = False

    def finding(a, b, discriminator, message, question, guidance, *, severity="warning", **scope):
        return ctx.finding(
            line=line, field="long_text", discriminator=discriminator, severity=severity, message=message,
            evidence={"family": "concrete", "short_values": sorted({item.grade for item in a}),
                      "long_values": sorted({item.grade for item in b}),
                      "short_quote": " / ".join(dict.fromkeys(item.quote for item in a)),
                      "long_quote": " / ".join(dict.fromkeys(item.quote for item in b)),
                      "bieterfrage_de": f"Zu Pos. {line.code}: {question}", **scope},
            suggested_fix=review_fix(guidance),
        )

    for component in sorted(left.keys() & right.keys()):
        a, b = left[component], right[component]
        if {item.grade for item in a}.isdisjoint(item.grade for item in b):
            findings = True
            yield finding(
                a, b, f"concrete:{component}",
                f"{label(line)} states different concrete grades for {component.title()}: "
                f"{', '.join(sorted({item.grade for item in a}))} and {', '.join(sorted({item.grade for item in b}))}.",
                f"Bitte bestätigen Sie die Betonfestigkeitsklasse für {component.title()} und gleichen Sie Kurz- und Langtext ab.",
                f"Confirm the specified grade for {component.title()} in the drawings or tender clarification "
                "and update both descriptions to that value.",
                component=component,
            )
    if findings:
        return
    if all(item.components for item in brief + full):
        for left_component, right_component in (("fundament", "bettung"), ("bettung", "fundament")):
            if left_component in left and right_component in right and (
                left_component not in right and right_component not in left
                and {item.grade for item in left[left_component]}.isdisjoint(item.grade for item in right[right_component])
            ):
                a, b = left[left_component], right[right_component]
                yield finding(
                    a, b, "concrete:scope",
                    f"{label(line)} assigns different grades to {left_component.title()} and {right_component.title()}. "
                    "Confirm whether the two labels refer to the same concrete.",
                    "Bitte bestätigen Sie, ob Fundament und Bettung dasselbe Bauteil bezeichnen, "
                    "und geben Sie die maßgebende Betonfestigkeitsklasse je Bauteil an.",
                    "Check the detail drawings for the relationship between foundation and bedding. "
                    "If they are one component, align both grades to the confirmed specification. "
                    "If they are separate, label the grade for each component.",
                    severity="info", short_components=[left_component], long_components=[right_component],
                )
                break
        return
    core = grades(INCLUDED_CLAUSE.sub(" ", detail))
    if core and {item.grade for item in brief}.isdisjoint(core):
        yield finding(
            brief, [item for item in full if item.grade in core], "concrete",
            f"{label(line)} states different concrete grades in the short and long text.",
            "Bitte bestätigen Sie die maßgebende Betonfestigkeitsklasse und das zugehörige Bauteil.",
            "Confirm the specified grade and the component it applies to, then align the two descriptions.",
        )


@rule("L1.TEXT.VALUE_CONFLICT", layer=1, category="text", severity="warning",
      title="Short and long text disagree", description="Disjoint values in concrete, fire, IP, board, labelled dimensions and directly attributed item heights or board thicknesses. DN differences are informational.")
def value_conflict(ctx):
    source_format = ctx.input.project.source_document.format
    for line in ctx.input.lines:
        detail = source_detail(line, source_format)
        yield from _concrete_conflicts(ctx, line, detail or "")
        # Values inside "einschließlich …" clauses belong to an included component (a blinding layer, an edge
        # strip), not to the item the short text names.
        short, long = values(line.short_text or ""), values(INCLUDED_CLAUSE.sub(" ", line.long_text or ""))
        for family in short:
            if family == "concrete":
                continue
            if short[family] and long[family] and short[family].isdisjoint(long[family]):
                yield ctx.finding(line=line, field="long_text", discriminator=family,
                    severity="info" if family == "DN" else "warning",
                    message=f"{label(line)}: {family} values differ between short and long text.",
                    evidence={"family": family, "short_values": sorted(short[family]), "long_values": sorted(long[family]),
                              "bieterfrage_de": f"Zu Pos. {line.code}: Kurz- und Langtext enthalten unterschiedliche Angaben ({FAMILY_DE[family]}: {', '.join(sorted(short[family]))} / {', '.join(sorted(long[family]))}). Bitte bestätigen Sie die maßgebende Ausführung."})

        for family, specification, heading_match, detail_match in attributed_dimensions(line.short_text, detail):
            heading_cm = centimetres(heading_match["number"], heading_match["unit"])
            detail_cm = centimetres(detail_match["number"], detail_match["unit"])
            if heading_cm == detail_cm:
                continue
            short_quote, long_quote = heading_match["quote"], detail_match["quote"]
            yield ctx.finding(
                line=line, field="long_text", discriminator=family,
                message=f"{label(line)} specifies {short_quote} in the short text and {long_quote} in the detail.",
                evidence={"family": family, "short_quote": short_quote, "long_quote": long_quote,
                          "short_dimension_cm": heading_cm, "long_dimension_cm": detail_cm,
                          "bieterfrage_de": f"Zu Pos. {line.code}: Bitte bestätigen Sie die maßgebende Angabe "
                                            f"({specification}: {short_quote} / {long_quote})."},
                suggested_fix=review_fix("Confirm the specified dimension in the drawings or tender schedule "
                                         "and align the short description and detail."),
            )


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
