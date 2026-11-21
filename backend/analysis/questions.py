"""Bidder questions (Bieterfragen) from findings: deterministic German templates keyed by rule id.

Nothing here calls a model or any service, so every question traces back to a finding and to
the position text, and no tender content leaves the machine. Rules about prices, arithmetic,
bidder input and import warnings have no template: they are not questions for the client.

Findings the reviewer dismissed (``status == rejected``) are left out. Findings of one rule in
one section are merged into one question that lists the OZ, so 73 positions without a quantity
become one question per section instead of 73.

Ported from origin/archive/risk-report-ui:analysis/questions.py. Contract v0.2 uses
Pydantic output, evidence-provided wording, change-order signals and points ordering.
Client-scope questions remain useful on priced files; price findings never become questions.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import re
from typing import Any

from .contracts import AnalysisInput, BidderQuestion, Finding, RiskReport
from .risk import assess
from .risk.signals import anchor, excluded_sections, matching_families

MAX_LISTED = 12
SHORT_TEXT_CHARS = 80

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
    "SHOP_DRAWINGS": "Werkstatt- und Montageplanung",
    "TRANSPORT_AND_ASSEMBLY": "Transport und Montage",
    "JOINT_SEALING": "Fugenabdichtung",
    "ANCHORS_AND_EMBEDDED_PARTS": "Anker und Einbauteile",
}


@dataclass
class _Item:
    finding: Finding
    oz: str
    short_text: str


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

_L2_SINGLE = ("Es ist keine Position für {dependency} enthalten. Bitte teilen Sie mit, ob diese "
              "Leistung in einer anderen Position enthalten ist, bauseits erbracht wird oder zusätzlich "
              "anzubieten ist.")
_L2_SHORTFALL = ("Für {dependency} sind nur {found} {unit} enthalten, bei {needed} {unit} der "
                 "zugehörigen Leistung. Bitte teilen Sie mit, ob die Menge zu ergänzen ist oder die Leistung "
                 "an anderer Stelle enthalten ist.")


def _number(value: Any) -> str:
    try:
        number = Decimal(str(value))
        if not number.is_finite():
            return "?"
    except (InvalidOperation, ValueError):
        return str(value)
    return f"{number:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".").rstrip("0").rstrip(",")


def _dependency_question(finding: Finding) -> str | None:
    evidence = finding.evidence or {}
    if evidence.get("reason") not in ("missing", "quantity_shortfall"):
        return None  # "not assessable" is our uncertainty, not a gap in the tender
    key = finding.rule_id.split("_NEEDS_", 1)[-1]
    dependency = DEPENDENCY_DE.get(key) or str(evidence.get("dependency") or key.replace("_", " ").title())
    if evidence.get("reason") == "quantity_shortfall" and evidence.get("trigger_quantity") is not None:
        if evidence.get("dependency_quantity") is None:
            return None
        return _L2_SHORTFALL.format(dependency=dependency, unit=evidence.get("quantity_unit") or "",
                                    found=_number(evidence.get("dependency_quantity")),
                                    needed=_number(evidence.get("trigger_quantity")))
    return _L2_SINGLE.format(dependency=dependency)


def has_template(rule_id: str) -> bool:
    return rule_id in TEMPLATES or ("_NEEDS_" in rule_id and rule_id.startswith("L2."))


def _body(text: str, refs: list[str]) -> str:
    normalized = " ".join(text.split())
    prefix = "Zu Pos. " + _oz_list(refs)
    if normalized.casefold().startswith(prefix.casefold()) and normalized[len(prefix):len(prefix) + 1] in {" ", ":", ""}:
        return normalized[len(prefix):].lstrip(" :")
    return re.sub(r"^(?:Zu\s+)?Pos\.\s+[^:]+:\s*", "", normalized, flags=re.I)


def _excluded(finding: Finding) -> bool:
    return (finding.status != "open" or finding.category in {"price", "arithmetic", "bidder_input"}
            or finding.rule_id.startswith(("L1.PRICE.", "L1.ARITH."))
            or "BIDDER_INPUT" in finding.rule_id)


def _topic(rule_id: str) -> str:
    if rule_id.startswith("L2."):
        return "Fehlende Leistungen"
    parts = rule_id.split(".")
    return {"QTY": "Mengen", "UNIT": "Abrechnungseinheit", "TEXT": "Leistungsbeschreibung",
            "DIN": "Technische Anforderungen"}.get(parts[1] if len(parts) > 1 else "", "Leistungsumfang")


def build_questions(analysis_input: AnalysisInput, findings: list[Finding], risk: RiskReport | None = None, *,
                    limit: int = 25) -> list[BidderQuestion]:
    """Group identical questions within a section and rank by their active item points."""
    risk = risk if risk is not None else assess(analysis_input, findings)
    lines, sections = analysis_input.line_by_id(), analysis_input.section_by_id()
    excluded = excluded_sections(analysis_input)
    groups: dict[tuple[str, str | None, str], dict] = {}
    represented: set[str] = set()

    def add(rule_id, section_id, refs, text, finding_ids, item_ids, order, topic, template=None):
        body = _body(text, refs)
        key = (rule_id, section_id, template or body)
        group = groups.setdefault(key, {"refs": [], "ids": set(), "items": set(), "order": order,
                                        "topic": topic, "template": template, "body": body})
        group["refs"].extend(ref for ref in refs if ref and ref not in group["refs"])
        group["ids"].update(finding_ids)
        group["items"].update(item_ids)
        group["order"] = min(group["order"], order)

    for finding in sorted(findings, key=lambda f: f.id):
        if _excluded(finding):
            continue
        line_id = anchor(finding, lines)
        line = lines.get(line_id)
        section_id = line.section_id if line else finding.target.section_id
        if section_id in excluded:
            continue
        section = sections.get(section_id)
        refs = [line.code] if line and line.code else [finding.target.line_code or (section.code if section else "?")]
        if finding.rule_id.startswith("L2."):
            triggers = [item.get("code") for item in finding.evidence.get("trigger_items", []) if isinstance(item, dict)]
            refs = list(dict.fromkeys(ref for ref in triggers if ref)) or refs
            if refs == ["?"]:
                refs = [lines[id].code for id in finding.related_line_ids if id in lines and lines[id].code] or refs
        explicit = finding.evidence.get("bieterfrage_de")
        template = None
        if isinstance(explicit, str) and explicit.strip():
            text = explicit.strip()
        elif finding.rule_id.startswith("L2.") and "_NEEDS_" in finding.rule_id:
            text = _dependency_question(finding)
        elif finding.rule_id in TEMPLATES:
            item = _Item(finding, refs[0], _shorten(line.short_text if line else section.title if section else ""))
            extras = {**finding.evidence, "pos": _pos(item), "oz": refs[0], "short_text": item.short_text,
                      "unit": (line.unit_raw or line.unit or "") if line else "",
                      "same_as": finding.evidence.get("same_as", "?")}
            text = TEMPLATES[finding.rule_id][0].format_map(_Safe(extras))
            template = finding.rule_id
        else:
            continue
        if not text:
            continue
        add(finding.rule_id, section_id, refs, text, [finding.id], [finding.id],
            line.sort_order if line else section.sort_order if section else -1, _topic(finding.rule_id), template)
        represented.add(finding.id)

    family_templates = {"ground": "GROUND", "by_client": "BY_CLIENT", "client_decides": "CLIENT_DECIDES",
                        "daywork": "DAYWORK", "cost_plus": "COST_PLUS", "conditional": "CONDITIONAL",
                        "thin_lump_sum": "THIN_LUMP_SUM"}
    signal_templates = {
        "provisional": "Bitte teilen Sie mit, ob und in welchem Umfang mit einer Beauftragung zu rechnen ist und ob die Position in die Wertung eingeht.",
        "vague_quantity": "Bitte bestätigen Sie die tatsächlich anzubietende Menge und die Grundlage ihrer Ermittlung.",
        "zero_qty_priced": "Bitte bestätigen Sie, ob die bepreiste Position mit Menge 0 entfällt oder welche Menge anzubieten ist.",
        "scope_gap": "Bitte konkretisieren Sie den Leistungsumfang, die Randbedingungen und die Abgrenzung zu anderen Leistungen.",
        "hourly_work": "Bitte teilen Sie uns den erwarteten Umfang der Stundenlohnarbeiten mit und ob er in die Wertung eingeht.",
        "by_client": "Bitte teilen Sie uns Umfang, Termin und Ort der bauseitigen Bereitstellung mit.",
    }
    for signal in risk.change_order_signals:
        if signal.finding_ids and set(signal.finding_ids) <= represented:
            continue
        line = lines[signal.line_id]
        families = matching_families(line)
        # Prefer the most specific high-value question when a scope signal combines reasons.
        family = next((name for name in ("ground", "by_client", "daywork", "cost_plus", "client_decides",
                                         "conditional", "thin_lump_sum")
                       if name in families and ((signal.kind == "scope_gap" and name not in {"by_client", "daywork"})
                                                or signal.kind == "by_client" and name == "by_client"
                                                or signal.kind == "hourly_work" and name == "daywork")), None)
        if family:
            text = TEMPLATES["L1.RISK." + family_templates[family]][0].format(pos="", oz="", short_text="").lstrip(": ")
        else:
            text = signal_templates.get(signal.kind)
        if text:
            add("CO." + signal.kind.upper(), line.section_id, [line.code or line.id], text,
                signal.finding_ids, [signal.id], line.sort_order, "Nachtragspotenzial")

    ranked = []
    for (rule_id, section_id, _), group in groups.items():
        body = group["body"]
        refs = group["refs"]
        order_by_code = {line.code: line.sort_order for line in lines.values()}
        refs.sort(key=lambda code: (order_by_code.get(code, -1), code))
        ids = sorted(group["ids"])
        identity = "|".join([rule_id, section_id or "", body, *sorted(group["items"])])
        separator = " " if re.match(r"^(?:ist|sind)\b", body, re.I) else ": "
        text = f"Zu Pos. {_oz_list(refs)}{separator}{body}"
        if len(refs) > 1 and group["template"]:
            text = TEMPLATES[group["template"]][1].format_map(_Safe({"ozs": _oz_list(refs), "n": len(refs)}))
        question = BidderQuestion(id="q_" + sha256(identity.encode()).hexdigest()[:20], rule_id=rule_id,
                                  topic=group["topic"], text_de=text, line_codes=refs, finding_ids=ids)
        points = sum((Decimal(str(risk.points.get(id, 0))) for id in sorted(group["items"])), Decimal(0))
        ranked.append((-points, group["order"], question.id, question))
    return [item[-1] for item in sorted(ranked)[:max(0, min(limit, 25))]]


class _Safe(dict):
    """format_map helper: a missing placeholder renders as '?' instead of raising."""

    def __missing__(self, key: str) -> str:
        return "?"


def questions_as_dicts(analysis_input: AnalysisInput, findings: list[Finding]) -> list[dict[str, Any]]:
    return [question.model_dump(mode="json") for question in build_questions(analysis_input, findings)]
