"""Change-order signals. Pure functions; no findings, model calls or source changes."""

from __future__ import annotations

from collections import Counter
from hashlib import sha256
import re

from ..contracts import AnalysisInput, ChangeOrderSignal, Finding, Line

# Families sharing a contract kind are combined into one signal per position.
# The message retains each matching reason; points are charged once per kind.
REGEX_SIGNALS = {
    "provisional": ("provisional", "Bedarfs- oder Eventualleistung", r"\b(?:bedarfs|eventual|wahl)(?:position(?:en)?|leistung(?:en)?)\b"),
    "daywork": ("hourly_work", "Stundenlohn- oder Regiearbeiten", r"\b(?:stundenlohn\w*|regie(?:arbeiten|stunden)?)\b"),
    "cost_plus": ("scope_gap", "Vergütung nach Aufwand", r"\bnach\s+(?:tats[aä]chlichem\s+)?aufwand\b"),
    "by_client": ("by_client", "Bauseitige oder beigestellte Leistung", r"\b(?:bauseits|beigestellt(?:e[rsnm]?)?)\b"),
    "client_decides": ("scope_gap", "Auswahl durch den Auftraggeber", r"\bnach\s+(?:angabe|wahl|anordnung)\s+(?:(?:des|der)\s+)?(?:ag|auftraggeber(?:s|in)?)\b|\bbemusterung\b"),
    "conditional": ("scope_gap", "Ausführung unter Vorbehalt", r"\b(?:ggf|evtl)\b\.?|\bsoweit\s+erforderlich\b"),
    "approximate": ("vague_quantity", "Ungefähre Mengenangabe", r"\bca\.(?=\s|\d|$)|\betwa\b"),
    "ground": ("scope_gap", "Baugrund- und Entsorgungsbedingungen", r"\b(?:homogenbereich(?:e[ns]?)?|fels(?:anteil|klassen?|gestein)?|grundwasser(?:stand|haltung)?|kampfmittel(?:sondierung|belastung)?|altlast(?:en)?|laga)\b"),
    "existing_fabric": ("scope_gap", "Eingriff in vorhandene Bausubstanz", r"\bim\s+bestand\b|\b(?:r[üu]ckbau|abbruch)(?:arbeiten)?\b|\bvorhandene[nrsm]?\s+leitungen?\b"),
    "time_related": ("scope_gap", "Zeitabhängige Leistung", r"\b(?:vorhalten|vorhaltung|stillstand)\b|\bje\s+(?:woche|monat|tag)\b"),
}
PATTERNS = {name: re.compile(item[2], re.I) for name, item in REGEX_SIGNALS.items()}
DAYWORK_NEGATION = re.compile(
    r"\b(?:keine?\w*|ohne)\s+(?:stundenlohn\w*|regie\w*)\b|"
    r"\b(?:stundenlohn\w*|regie\w*)\s+(?:(?:sind|ist|werden|wird)\s+)?nicht\s+(?:vorgesehen|erforderlich|beauftragt)\b", re.I)
TITLES = {
    "scope_gap": "Leistungsumfang und Randbedingungen klären", "provisional": "Bedarfsleistung klären",
    "hourly_work": "Umfang der Stundenlohnarbeiten klären", "by_client": "Bauseitige Leistungen abgrenzen",
    "vague_quantity": "Unsichere Mengenbasis",
    "zero_qty_priced": "Bepreiste Leistung ohne Menge",
}
ACTIONS = {
    "scope_gap": "Leistungsgrenze, Abrechnung und Preisannahmen vor Angebotsabgabe klären.",
    "provisional": "Erwartete Menge und Berücksichtigung in der Angebotswertung klären.",
    "hourly_work": "Anzusetzende Stunden, Stundensatz und Abrechnung klären.",
    "by_client": "Verantwortung, Liefertermin und Übergabepunkt klären.",
    "vague_quantity": "Kalkulationsmenge und ihre Ermittlung bestätigen.",
    "zero_qty_priced": "Anzubietende Menge oder Verwendung als Einheitspreisposition klären.",
}
BASE_POINTS = {"scope_gap": 4, "provisional": 4, "hourly_work": 4, "by_client": 2,
               "vague_quantity": 2, "zero_qty_priced": 4}
WORDING_KINDS = frozenset({"scope_gap", "provisional", "hourly_work", "by_client", "vague_quantity"})
EXTRA_SIGNALS = {"thin_lump_sum": ("scope_gap", "Pauschale mit weniger als 200 Zeichen Leistungsbeschreibung"),
                 "placeholder_quantity": ("vague_quantity", "Menge 1 bei einer messbaren Leistung; mögliche Platzhaltermenge"),
                 "zero_qty_priced": ("zero_qty_priced", "Einheitspreis vorhanden, aber Menge 0")}
MEASURED_UNITS = {"m", "m²", "m³", "m2", "m3", "t", "h"}


def line_text(line: Line) -> str:
    return " ".join(" ".join((line.short_text or "", line.long_text or "")).split())


def matching_families(line: Line) -> list[str]:
    text = line_text(line)
    families = [name for name, pattern in PATTERNS.items() if pattern.search(text)]
    no_daywork = bool(DAYWORK_NEGATION.search(text))
    if no_daywork and "daywork" in families:
        families.remove("daywork")
    if line.unit == "h" and not no_daywork and "daywork" not in families:
        families.append("daywork")
    if line.total_rule == "conditional" and "provisional" not in families:
        families.append("provisional")
    if line.pricing_basis == "lump_sum" and 0 < len(text) < 200:
        families.append("thin_lump_sum")
    if line.quantity == 1 and line.unit in MEASURED_UNITS and line.pricing_basis != "lump_sum":
        families.append("placeholder_quantity")
    if (line.quantity == 0 and line.total_rule == "include"
            and any(price and price.unit_price is not None for price in (line.price, line.source_amounts))):
        families.append("zero_qty_priced")
    return families


def wording_families(line: Line, kind: str) -> list[str]:
    return [family for family in matching_families(line)
            if ((family in REGEX_SIGNALS and REGEX_SIGNALS[family][0] == kind)
                or (family in EXTRA_SIGNALS and EXTRA_SIGNALS[family][0] == kind))]


def anchor(finding: Finding, lines: dict[str, Line]) -> str | None:
    if finding.target.line_id in lines:
        return finding.target.line_id
    related = [lines[id] for id in finding.related_line_ids if id in lines]
    return min(related, key=lambda line: (line.sort_order, line.id)).id if related else None


def excluded_sections(analysis_input: AnalysisInput) -> set[str]:
    sections = analysis_input.section_by_id()
    excluded = set()
    for id in sections:
        current, seen = id, set()
        while current in sections and current not in seen:
            seen.add(current)
            section = sections[current]
            if re.search(r"\bnachtr(?:ag|äge)\b", section.title or "", re.I):
                excluded.add(id)
                break
            current = section.parent_id
    return excluded


def collect(analysis_input: AnalysisInput, findings: list[Finding]) -> list[ChangeOrderSignal]:
    lines = analysis_input.line_by_id()
    excluded = excluded_sections(analysis_input)
    codes = Counter(line.code for line in lines.values() if line.code)
    zero_findings = {finding.target.line_id for finding in findings
                     if finding.status == "open" and finding.rule_id == "L1.QTY.ZERO"}
    groups: dict[tuple[str, str], list[str]] = {}
    for line in sorted(lines.values(), key=lambda line: (line.sort_order, line.id)):
        if line.section_id in excluded:
            continue
        for family in matching_families(line):
            kind, message = REGEX_SIGNALS[family][:2] if family in REGEX_SIGNALS else EXTRA_SIGNALS[family]
            if kind == "zero_qty_priced" and line.id in zero_findings:
                continue
            reasons = groups.setdefault((line.id, kind), [])
            if message not in reasons:
                reasons.append(message)
    result = []
    for (id, kind), reasons in groups.items():
        line = lines[id]
        ref = line.code or line.id
        if line.code and codes[line.code] > 1:
            ref += "_" + sha256(line.id.encode()).hexdigest()[:8]
        result.append(ChangeOrderSignal(id=f"co_{ref}_{kind}", kind=kind, line_id=id, line_code=line.code,
                                        title=TITLES[kind], message=". ".join([*reasons, ACTIONS[kind]]),
                                        points=BASE_POINTS[kind]))
    return sorted(result, key=lambda item: (lines[item.line_id].sort_order, item.kind, item.id))
