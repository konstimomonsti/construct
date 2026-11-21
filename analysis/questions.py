"""Bidder questions (Bieterfragen) from findings: deterministic German templates keyed by rule id.

Nothing here calls a model or any service, so every question traces back to a finding and to
the position text, and no tender content leaves the machine. Rules about prices, arithmetic,
bidder input and import warnings have no template: they are not questions for the client.

Findings the reviewer dismissed (``status == rejected``) are left out. Findings of one rule in
one section are merged into one question that lists the OZ, so 73 positions without a quantity
become one question per section instead of 73.

Only tenders get questions: a bid (GAEB phase 84) or an award (86) has already been priced.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict, dataclass, field
from hashlib import sha256
from typing import Any, Callable

from analysis.contracts import AnalysisInput, Finding, Status

TENDER_PHASES = {None, "", "81", "82", "83"}
MAX_LISTED = 12
SHORT_TEXT_CHARS = 80
SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}

# Dependency names (layer 2) in German, keyed by the dependency key in the rule id
# ("L2.FLOOR.SCREED_NEEDS_EDGE_INSULATION" -> "EDGE_INSULATION").
DEPENDENCY_DE = {
    "EDGE_INSULATION": "Randdämmstreifen", "UNDERLAYS_AND_INSULATION": "Trittschall- und Wärmedämmung",
    "PRIMER_AND_LEVELING": "Voranstrich und Ausgleich", "FLOOR_COVERING": "Bodenbelag",
    "SKIRTING": "Sockelleisten", "FORMWORK": "Schalung", "REINFORCEMENT_STEEL": "Bewehrungsstahl",
    "CLEAN_LAYER": "Sauberkeitsschicht", "INSULATION_AND_ACOUSTICS": "Dämmung und Schallschutz",
    "JOINT_FILLING": "Fugenspachtelung", "EDGE_PROTECTION": "Kantenschutz",
    "MASKING_AND_PROTECTION": "Abdeckungen und Schutzmaßnahmen",
    "SURFACE_PREPARATION_AND_PRIMER": "Untergrundvorbereitung und Grundierung",
    "VAPOR_BARRIER": "Dampfsperre", "THERMAL_INSULATION": "Wärmedämmung",
    "ROOF_DRAINAGE": "Dachentwässerung", "INSTALLATION_CABLE": "Installationsleitungen",
    "DEVICE_BOXES": "Geräte- und Abzweigdosen", "RCD_PROTECTION": "Fehlerstromschutzeinrichtungen (RCD)",
    "INITIAL_VERIFICATION": "Erstprüfung nach DIN VDE 0100-600", "AS_BUILT_DOCUMENTS": "Revisionsunterlagen",
    "EMERGENCY_LIGHTING": "Sicherheitsbeleuchtung", "LIGHTING_CONTROL": "Lichtsteuerung",
    "CABLE_ROUTING": "Kabeltrassen und Leitungsführung", "CABLE_TERMINATION": "Leitungsanschlüsse",
    "EARTHING": "Erdung", "EQUIPOTENTIAL_BONDING": "Potentialausgleich", "INSPECTION": "Prüfung",
    "WC_SEAT": "WC-Sitze", "FLUSH_PLATE": "Betätigungsplatten", "MOUNTING_FRAME": "Vorwandelemente",
    "PIPE_INSULATION": "Rohrdämmung", "PRESSURE_TEST": "Druckprüfung",
    "FLUSHING_AND_DISINFECTION": "Spülung und Desinfektion", "WATER_SAMPLING": "Trinkwasserprobenahme",
    "PRIMER": "Grundierung", "WET_ROOM_WATERPROOFING": "Abdichtung im Nassbereich",
    "ELASTIC_JOINTS": "elastische Fugen", "SKIRTING_AND_EDGE_PROFILES": "Sockel und Kantenprofile",
    "DOOR_CLOSER": "Türschließer", "LOCK_CYLINDER": "Schließzylinder", "DOOR_HARDWARE": "Beschläge",
    "SAFETY_EDGE_OR_LIGHT_BARRIER": "Schaltleiste oder Lichtschranke",
    "DRIVE_POWER_SUPPLY": "Stromversorgung des Antriebs", "WINDOW_SILLS": "Fensterbänke",
    "INSTALLATION_JOINT_SEALING": "Anschlussfugenabdichtung",
}


@dataclass
class Question:
    id: str
    rule_id: str
    severity: str
    section: str | None
    refs: list[str]  # OZ the question is about
    finding_ids: list[str]
    text: str
    sort_order: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class _Item:
    finding: Finding
    oz: str
    short_text: str
    extra: dict[str, Any] = field(default_factory=dict)


def _shorten(text: str | None) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= SHORT_TEXT_CHARS else text[:SHORT_TEXT_CHARS - 1].rstrip() + "…"


def _oz_list(codes: list[str]) -> str:
    codes = list(dict.fromkeys(codes))
    shown = codes[:MAX_LISTED]
    text = ", ".join(shown)
    return text + f" und {len(codes) - MAX_LISTED} weitere" if len(codes) > MAX_LISTED else text


def _pos(item: _Item) -> str:
    return f"Pos. {item.oz} „{item.short_text}“" if item.short_text else f"Pos. {item.oz}"


# Each template has a singular and a plural text. The plural form gets {ozs} (all OZ) and {n}.
# The singular gets {pos} ("Pos. 01.02 „Kurztext“"), {oz}, {short_text} and the finding's extras.
TEMPLATES: dict[str, tuple[str, str]] = {
    "L1.QTY.MISSING": (
        "{pos}: Für diese Position ist keine Menge angegeben. Bitte teilen Sie uns die anzubietende Menge mit "
        "bzw. bestätigen Sie, ob die Leistung pauschal anzubieten ist.",
        "Zu den Positionen {ozs} ({n} Positionen) ist keine Menge angegeben. Bitte teilen Sie uns die jeweils "
        "anzubietenden Mengen mit bzw. bestätigen Sie, ob die Leistungen pauschal anzubieten sind."),
    "L1.QTY.ZERO": (
        "{pos}: Die Menge ist mit 0 angegeben. Bitte bestätigen Sie, ob die Position entfällt oder ob eine "
        "Menge anzubieten ist.",
        "Bei den Positionen {ozs} ist die Menge mit 0 angegeben. Bitte bestätigen Sie, ob diese Positionen "
        "entfallen oder ob Mengen anzubieten sind."),
    "L1.QTY.NEGATIVE": (
        "{pos}: Die Menge ist negativ angegeben. Bitte bestätigen Sie die Menge bzw. teilen Sie uns die "
        "richtige Menge mit.",
        "Bei den Positionen {ozs} sind die Mengen negativ angegeben. Bitte bestätigen Sie die Mengen bzw. "
        "teilen Sie uns die richtigen Mengen mit."),
    "L1.QTY.FRACTIONAL_COUNT": (
        "{pos}: Die Menge einer Stückposition ist mit Nachkommastellen angegeben. Bitte bestätigen Sie die "
        "Menge oder teilen Sie uns die zu kalkulierende Stückzahl mit.",
        "Bei den Positionen {ozs} sind Stückmengen mit Nachkommastellen angegeben. Bitte bestätigen Sie die "
        "Mengen oder teilen Sie uns die zu kalkulierenden Stückzahlen mit."),
    "L1.QTY.PLACEHOLDER": (
        "{pos}: Die Menge 1 bei einer Mengeneinheit (kein Pauschalposten) wirkt wie ein Platzhalter. Bitte "
        "teilen Sie uns die tatsächlich zu kalkulierende Menge mit.",
        "Bei den Positionen {ozs} wirkt die Menge 1 wie ein Platzhalter. Bitte teilen Sie uns die "
        "tatsächlich zu kalkulierenden Mengen mit."),
    "L1.UNIT.MISSING": (
        "{pos}: Es ist keine Einheit angegeben. Bitte teilen Sie uns mit, in welcher Einheit die Position "
        "abzurechnen ist.",
        "Bei den Positionen {ozs} ist keine Einheit angegeben. Bitte teilen Sie uns mit, in welcher Einheit "
        "diese Positionen abzurechnen sind."),
    "L1.UNIT.UNKNOWN": (
        "{pos}: Die angegebene Einheit „{unit}“ ist uns nicht eindeutig. Bitte bestätigen Sie die "
        "Abrechnungseinheit.",
        "Bei den Positionen {ozs} sind Einheiten angegeben, die uns nicht eindeutig sind. Bitte bestätigen "
        "Sie die Abrechnungseinheiten."),
    "L1.UNIT.TEXT_MISMATCH": (
        "{pos}: Die Einheit passt nicht zur Abrechnungsangabe im Text. Bitte bestätigen Sie, nach welcher "
        "Einheit abzurechnen ist.",
        "Bei den Positionen {ozs} passt die Einheit nicht zur Abrechnungsangabe im Text. Bitte bestätigen "
        "Sie, nach welcher Einheit abzurechnen ist."),
    "L1.LUMP.INCONSISTENT": (
        "{pos}: Die Position ist als Pauschale bezeichnet, weist aber eine Menge ungleich 1 aus. Bitte "
        "teilen Sie uns mit, ob pauschal oder nach Menge anzubieten ist.",
        "Die Positionen {ozs} sind als Pauschale bezeichnet, weisen aber Mengen ungleich 1 aus. Bitte "
        "teilen Sie uns mit, ob pauschal oder nach Menge anzubieten ist."),
    "L1.DUP.SUSPECTED": (
        "Pos. {oz} und Pos. {same_as} beschreiben dem Anschein nach dieselbe Leistung. Bitte bestätigen "
        "Sie, ob beide Positionen getrennt anzubieten sind oder ob eine Doppelung vorliegt.",
        "Die Positionen {ozs} beschreiben dem Anschein nach Leistungen, die bereits an anderer Stelle "
        "desselben Abschnitts enthalten sind. Bitte bestätigen Sie, ob diese Positionen getrennt anzubieten "
        "sind oder ob Doppelungen vorliegen."),
    "L1.CODE.DUPLICATE": (
        "{pos}: Die Ordnungszahl ist mehrfach vergeben. Bitte teilen Sie uns die korrekte Ordnungszahl bzw. "
        "die Zuordnung der Positionen mit.",
        "Die Ordnungszahlen {ozs} sind mehrfach vergeben. Bitte teilen Sie uns die korrekte Zuordnung der "
        "Positionen mit."),
    "L1.STRUCT.PROVISIONAL_ITEM": (
        "Pos. {oz} ist als Bedarfsposition gekennzeichnet. Bitte teilen Sie mit, ob und in welchem Umfang "
        "mit einer Beauftragung zu rechnen ist und ob die Position in die Wertung eingeht.",
        "Die Positionen {ozs} sind als Bedarfspositionen gekennzeichnet. Bitte teilen Sie mit, ob und in "
        "welchem Umfang mit einer Beauftragung zu rechnen ist und ob sie in die Wertung eingehen."),
    "L1.STRUCT.ORPHAN_ALTERNATIVE": (
        "{pos}: Die Alternativposition hat keine erkennbare Grundposition. Bitte teilen Sie uns mit, auf "
        "welche Position sie sich bezieht.",
        "Die Alternativpositionen {ozs} haben keine erkennbare Grundposition. Bitte teilen Sie uns mit, auf "
        "welche Positionen sie sich beziehen."),
    "L1.STRUCT.EMPTY_SECTION": (
        "Der Abschnitt {oz} enthält keine Positionen. Bitte bestätigen Sie, ob Positionen fehlen.",
        "Die Abschnitte {ozs} enthalten keine Positionen. Bitte bestätigen Sie, ob Positionen fehlen."),
    "L1.TEXT.MISSING": (
        "{pos}: Zu dieser Position liegt kein Langtext vor. Bitte stellen Sie die vollständige "
        "Leistungsbeschreibung zur Verfügung.",
        "Zu den Positionen {ozs} liegt kein Langtext vor. Bitte stellen Sie die vollständigen "
        "Leistungsbeschreibungen zur Verfügung."),
    "L1.TEXT.OR_EQUIVALENT": (
        "{pos}: Es ist „oder gleichwertig“ angegeben. Bitte nennen Sie die Kriterien, nach denen die "
        "Gleichwertigkeit beurteilt wird, und die geforderten technischen Eigenschaften.",
        "Bei den Positionen {ozs} ist „oder gleichwertig“ angegeben. Bitte nennen Sie die Kriterien, nach "
        "denen die Gleichwertigkeit beurteilt wird, und die geforderten technischen Eigenschaften."),
    # Risk signals (layer 1 risk rules, plan section 3). They produce questions as soon as they exist.
    "L1.RISK.GROUND": (
        "{pos}: Bitte stellen Sie das Baugrundgutachten mit Homogenbereichen und dem erwarteten Fels- und "
        "Grundwasseranteil zur Verfügung.",
        "Zu den Positionen {ozs}: Bitte stellen Sie das Baugrundgutachten mit Homogenbereichen und dem "
        "erwarteten Fels- und Grundwasseranteil zur Verfügung."),
    "L1.RISK.BY_CLIENT": (
        "{pos}: Es ist von bauseitigen bzw. beigestellten Leistungen die Rede. Bitte teilen Sie uns Umfang, "
        "Termin und Ort der Bereitstellung mit.",
        "Zu den Positionen {ozs}: Es ist von bauseitigen bzw. beigestellten Leistungen die Rede. Bitte "
        "teilen Sie uns jeweils Umfang, Termin und Ort der Bereitstellung mit."),
    "L1.RISK.CLIENT_DECIDES": (
        "{pos}: Die Ausführung soll nach Angabe, Wahl oder Anordnung des Auftraggebers erfolgen. Bitte "
        "teilen Sie uns die Auswahlmöglichkeiten und den Zeitpunkt der Entscheidung mit.",
        "Zu den Positionen {ozs}: Die Ausführung soll nach Angabe, Wahl oder Anordnung des Auftraggebers "
        "erfolgen. Bitte teilen Sie uns die Auswahlmöglichkeiten und den Zeitpunkt der Entscheidung mit."),
    "L1.RISK.DAYWORK": (
        "{pos}: Bitte teilen Sie uns den erwarteten Umfang der Stundenlohnarbeiten mit und ob er in die "
        "Wertung eingeht.",
        "Zu den Positionen {ozs}: Bitte teilen Sie uns den erwarteten Umfang der Stundenlohnarbeiten mit und "
        "ob er in die Wertung eingeht."),
    "L1.RISK.COST_PLUS": (
        "{pos}: Die Leistung wird nach Aufwand vergütet. Bitte teilen Sie uns den erwarteten Umfang und die "
        "Abrechnungsgrundlage mit.",
        "Zu den Positionen {ozs}: Die Leistungen werden nach Aufwand vergütet. Bitte teilen Sie uns den "
        "erwarteten Umfang und die Abrechnungsgrundlage mit."),
    "L1.RISK.CONDITIONAL": (
        "{pos}: Die Leistung ist an Bedingungen geknüpft („ggf.“, „soweit erforderlich“). Bitte teilen Sie "
        "uns mit, wann sie auszuführen ist und wie sie vergütet wird.",
        "Zu den Positionen {ozs}: Die Leistungen sind an Bedingungen geknüpft („ggf.“, „soweit "
        "erforderlich“). Bitte teilen Sie uns mit, wann sie auszuführen sind und wie sie vergütet werden."),
    "L1.RISK.EXTERNAL_REF": (
        "{pos}: Der Text verweist auf Pläne, Gutachten oder Unterlagen. Bitte stellen Sie die "
        "Unterlagen zur Verfügung.",
        "Zu den Positionen {ozs}: Die Texte verweisen auf Pläne, Gutachten oder Unterlagen. Bitte stellen "
        "Sie die Unterlagen zur Verfügung."),
    "L1.RISK.THIN_LUMP_SUM": (
        "{pos}: Die Pauschale ist nur knapp beschrieben. Bitte teilen Sie uns den genauen Leistungsumfang "
        "und die Abgrenzung mit.",
        "Zu den Positionen {ozs}: Die Pauschalen sind nur knapp beschrieben. Bitte teilen Sie uns den "
        "genauen Leistungsumfang und die Abgrenzung mit."),
}

_L2_SINGLE = ("Zu {refs} ist keine Position für {dependency} enthalten. Bitte teilen Sie mit, ob diese "
              "Leistung in einer anderen Position enthalten ist, bauseits erbracht wird oder zusätzlich "
              "anzubieten ist.")
_L2_SHORTFALL = ("Zu {refs} sind {dependency} nur mit {found} {unit} enthalten, bei {needed} {unit} der "
                 "zugehörigen Leistung. Bitte teilen Sie mit, ob die Menge zu ergänzen ist oder die Leistung "
                 "an anderer Stelle enthalten ist.")


def _number(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    return f"{number:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".").rstrip("0").rstrip(",")


def _dependency_question(finding: Finding, refs: list[str]) -> str | None:
    evidence = finding.evidence or {}
    if evidence.get("reason") not in ("missing", "quantity_shortfall"):
        return None  # "not assessable" is our uncertainty, not a gap in the tender
    key = finding.rule_id.split("_NEEDS_", 1)[-1]
    dependency = DEPENDENCY_DE.get(key) or str(evidence.get("dependency") or key.replace("_", " ").title())
    where = ("Pos. " + _oz_list(refs)) if refs else "diesem Leistungsbereich"
    if evidence.get("reason") == "quantity_shortfall" and evidence.get("trigger_quantity") is not None:
        return _L2_SHORTFALL.format(refs=where, dependency=dependency, unit=evidence.get("quantity_unit", ""),
                                    found=_number(evidence.get("dependency_quantity")),
                                    needed=_number(evidence.get("trigger_quantity")))
    return _L2_SINGLE.format(refs=where, dependency=dependency)


def has_template(rule_id: str) -> bool:
    return rule_id in TEMPLATES or ("_NEEDS_" in rule_id and rule_id.startswith("L2."))


def is_tender(analysis_input: AnalysisInput) -> bool:
    return analysis_input.project.gaeb_phase in TENDER_PHASES


def _items(analysis_input: AnalysisInput, findings: list[Finding]) -> list[tuple[_Item, str | None, int]]:
    lines, sections = analysis_input.line_by_id(), analysis_input.section_by_id()
    out = []
    for finding in findings:
        line = lines.get(finding.target.line_id or "")
        section = sections.get(finding.target.section_id or "") if line is None else sections.get(line.section_id or "")
        if line is not None:
            item = _Item(finding, line.code or "?", _shorten(line.short_text))
            order = line.sort_order
        elif finding.target.section_id in sections:
            sec = sections[finding.target.section_id]
            item = _Item(finding, sec.code or "?", _shorten(sec.title))
            order = sec.sort_order
        else:
            item = _Item(finding, "?", "")
            order = 0
        label = None
        if section is not None:
            label = f"{section.code or ''} {section.title or ''}".strip() or None
        out.append((item, label, order))
    return out


def build_questions(analysis_input: AnalysisInput, findings: list[Finding], *,
                    limit: int | None = None) -> list[Question]:
    """Questions for the open and accepted findings of one BoQ, in document order."""
    if not is_tender(analysis_input):
        return []
    live = [f for f in findings if f.status != Status.REJECTED.value and has_template(f.rule_id)]
    groups: dict[tuple, list[tuple[_Item, int]]] = defaultdict(list)
    labels: dict[tuple, str | None] = {}
    for item, label, order in _items(analysis_input, live):
        f = item.finding
        if f.rule_id.startswith("L2."):
            key = (f.rule_id, f.id)  # one question per layer 2 finding
        else:
            key = (f.rule_id, label)
        groups[key].append((item, order))
        labels[key] = label

    lines = analysis_input.line_by_id()
    questions: list[Question] = []
    for key, members in groups.items():
        members.sort(key=lambda m: m[1])
        items = [m[0] for m in members]
        rule_id = key[0]
        text: str | None
        refs = list(dict.fromkeys(i.oz for i in items))
        if rule_id.startswith("L2."):
            finding = items[0].finding
            trigger_codes = [t.get("code") for t in (finding.evidence or {}).get("trigger_items", [])
                             if t.get("code")]
            if not trigger_codes:
                trigger_codes = [lines[i].code for i in finding.related_line_ids
                                 if i in lines and lines[i].code]
            refs = list(dict.fromkeys(trigger_codes))
            text = _dependency_question(finding, refs)
        elif len(items) == 1:
            item = items[0]
            extra = dict(item.finding.evidence or {})
            line = lines.get(item.finding.target.line_id or "")
            extra.setdefault("unit", (line.unit_raw or line.unit) if line else "")
            extra.setdefault("same_as", extra.get("same_as") or "?")
            text = TEMPLATES[rule_id][0].format_map(_Safe(
                {**extra, "pos": _pos(item), "oz": item.oz, "short_text": item.short_text}))
        else:
            text = TEMPLATES[rule_id][1].format_map(_Safe({"ozs": _oz_list(refs), "n": len(refs)}))
        if not text:
            continue
        worst = min((i.finding.severity for i in items), key=lambda s: SEVERITY_ORDER[s])
        ids = [i.finding.id for i in items]
        questions.append(Question(
            id="q_" + sha256("|".join([rule_id, *ids]).encode()).hexdigest()[:12],
            rule_id=rule_id, severity=worst, section=labels[key], refs=refs, finding_ids=ids, text=text,
            sort_order=members[0][1]))
    questions.sort(key=lambda q: (q.sort_order, SEVERITY_ORDER[q.severity], q.rule_id))
    return questions[:limit] if limit else questions


class _Safe(dict):
    """format_map helper: a missing placeholder renders as '?' instead of raising."""

    def __missing__(self, key: str) -> str:
        return "?"


def questions_as_dicts(analysis_input: AnalysisInput, findings: list[Finding]) -> list[dict[str, Any]]:
    return [q.to_dict() for q in build_questions(analysis_input, findings)]


# Type alias so callers can swap in another generator (for example a polished version).
QuestionBuilder = Callable[[AnalysisInput, list[Finding]], list[Question]]
