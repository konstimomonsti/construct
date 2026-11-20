"""Project the supplied Challenge A tenders into the material catalogue for review."""

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
import json
import re
import unicodedata
from uuid import UUID

from .store import jsonb


# Order companion files by the quality of their item descriptions. A later
# exchange can contribute new positions, even when its descriptions rank lower.
FAMILIES = {
    "an24-0305": (
        "Leistungsverzeichnis.pdf", "LV-Schachtbauwerk.pdf", "Angebot AN24-0305.pdf",
        "LV-Positionen.docx", "Angebot AN24-0305.D84",
    ),
    "23a0051": (
        "[NUMMER_001]_leer.X83", "Leistungsverzeichnis_leer.pdf", "Abgabe LV.pdf",
        "StBALV23040.D86", "StBALV23040.D84",
    ),
    "8209.003": (
        "8209.003_Leistungsverzeichnis_leer.X83", "HEM2301-2_Gesamt-LV.pdf",
        "8209.003_Leistungsverzeichnis_leer.D83", "[ORT_024] LV24069.D86",
    ),
    "projekte-004": ("GAEB-[PROJEKT_004].X83", "LV-Ausdruck-[PROJEKT_004].pdf"),
}
COMPANIONS = {
    name: (family, rank)
    for family, names in FAMILIES.items()
    for rank, name in enumerate(names)
}
AN24_PDF = "Angebot AN24-0305.pdf"
AN24_D84 = "Angebot AN24-0305.D84"
AN24_HASH = "3c7750d41acd2fd1714edf7ed915b4c88df40f772a35a0a9236a606db4f3892f"
AN24_SUPPLY = {
    "2.1.180", "3.1.10", "3.1.20", "3.1.30", "3.1.40", "3.1.50", "3.1.60",
    "3.1.70", "4.1.10", "4.1.20", "7.1.190", "7.1.200", "7.1.210", "7.1.220",
    "7.1.230", "7.1.240", "7.1.250",
}
AN24_DATE = date(2024, 11, 25)
AN24_BIDDER = "[FIRMA_110] (AN24-0305 bidder)"

# Confirmed against the X83 and priced PDF. Preserve the damaged code on the
# legacy evidence and use the intact position number only for grouping.
LEGACY_POSITION = {("23a0051", "TEL00009"): "8.1.3"}

PRODUCT_OVERRIDES = {
    "an24-0305:2.1.460": ("PP-Rohr-Böschungskopf DN 300", "Pipe fittings"),
    "an24-0305:2.1.470": ("Ortungsband mit zwei Edelstahldrähten", "Electrical equipment"),
    "an24-0305:3.2.500": (None, "Site equipment"),
    "an24-0305:3.2.600": ("Ausgleichsring, Höhe 6 cm", "Manholes and covers"),
    "an24-0305:3.2.610": ("Ausgleichsring, Höhe 8 cm", "Manholes and covers"),
    "an24-0305:3.2.620": ("Ausgleichsring, Höhe 10 cm", "Manholes and covers"),
    "an24-0305:2.3.150": ("Saatgut für Wiesenflächen", "Road materials"),
    "23a0051:1.1.8": (None, "Site equipment"),
    "23a0051:3.2.25": (None, "Aggregates and binders"),
    "23a0051:8.1.10": (None, "Pipe fittings"),
    "23a0051:8.1.17": (None, "Drainage"),
    "23a0051:8.1.22": (None, "Drainage"),
    "23a0051:8.1.24": (None, "Fasteners and metalwork"),
    "8209.003:8.1.7": (None, "Valves and controls"),
    "8209.003:8.3.9": (None, "Heating and ventilation"),
    "8209.003:8.3.10": (None, "Pipe fittings"),
    "8209.003:8.3.11": (None, "Pipe fittings"),
    "8209.003:8.4.1": (None, "Pipes"),
    "8209.003:8.5.1": (None, "Valves and controls"),
    "LV_00_Roh_und_Erdauarbeiten.pdf:3.2.95": ("Auflagerplatte für [PERSON_055]", "Fasteners and metalwork"),
}

TRADE_CATEGORIES = {
    "01": "Precast concrete", "02": "Floor finishes", "03": "Paint and coatings",
    "04": "Wall systems", "05": "Wall systems", "06": "Floor finishes",
    "07": "Floor finishes", "08": "Tiles and stone", "09": "Roof systems",
    "10": "Precast concrete", "11": "Precast concrete", "12": "Roof systems",
    "13": "Electrical equipment", "14a": "Heating and ventilation",
    "14b": "Drainage", "14c": "Heating and ventilation", "14": "Plumbing fixtures",
    "15a": "Waterproofing", "15": "Waterproofing", "17": "Wall systems",
    "18": "Floor finishes", "19": "Doors and gates", "20": "Floor finishes",
    "21": "Tiles and stone", "22": "Joinery and furniture", "23": "Wall systems",
}
PRODUCT_TERMS = {
    "Cable conduits": r"leerrohr|kabelschutzrohr|elektroinstallationsrohr|kabelkanal|kabelrinne|kabelzug",
    "Control cables": r"steuerkabel|steuerleitung",
    "Electrical equipment": r"kabel|\bny[my][cwj]|leitungsschutz|steckdose|\b(?:schuko|lichtschalter)|leuchte|lichtband|strahler|potentialausgleich|potential-ausgleich|erdungsband|forderband|trennfunkenstrecke|anschlusskasten|bewegungsmelder|\bled\b|durchgangsklemme|unterverteil|hauptverteil|\bsicherung",
    "Pipe fittings": r"\bmuffe\b|muffenschutz|muffenbogen|muffenverbindung|formst(?:ü|ue)ck|\b(?:ffr|mmk|pass-)\b|rohrverbinder|endkappe|ringraumdichtung|klemmring|isolierflansch|storzkupplung|gelenkst(?:ü|ue)ck|b(?:ö|oe)schungsst(?:ü|ue)ck|reduzierst(?:ü|ue)ck|(?<!druck)flansch|pressio|link-seal|t-st(?:ü|ue)ck|rohrbogen|rohrschelle|kupplung|abzweig",
    "Valves and controls": r"armatur|ventil|absperr|\bschieber|kugelhahn|sicherheitsgruppe|(?:rück|rueck)(?:schlag|fluss|fluß)|entl(?:ü|ue)fter|stellantrieb|auslaufhahn|froschklappe|wasserschieber",
    "Pipes": r"\b(?:pe-xa|pe-hd|pe100|pp|pvc)[ -]?rohr|druckrohr|muffendruckrohr|stahlbetonrohr|edelstahl.?rohr|\b(?:guss|guß|stahl|schutz|medien|mantel|drän)rohr|rohr(?:leitung|register)|\brohr(?:e|en)?\b|anschlussltg|kleinleitung|\bsanpress\b|\b(?:schlauch|zirkulationsleitung)\b",
    "Drainage": r"bodeneinlauf|dacheinlauf|dachablauf|dach(?:entwässerung|gully)|entwässerungsrinne|rinnenkörper|dampfsperrenanschluss|drainage|siphon",
    "Manholes and covers": r"schacht(?:deckel|ring|hals|abdeckung|vierung|unterteil|oberteil|bauwerk|boden)|tangentialschacht|\bschacht\b|schachtfertigteil|einlaufbauwerk|straßenkappe|ausgleichsring",
    "Pumps and machinery": r"pumpe(?!nsumpf)|\bksb\b|\betabloc\b|dosier(?:station|anlage)|verdichtereinheit|\bbeschicker|wasserstrahlventilator|\bdruckerhöhungs",
    "Measurement and instrumentation": r"messgerät|messsensor|mess.?sensor|magnetisch-induktiv|manometer|messumformer|wasserzähler|temperaturf(?:ü|ue)hler|messtopf|mengenzähler|messstrecke|druckmess|sensor|\bthermostat\b|messwertgeber",
    "Heating and ventilation": r"luftfilter|filtereinheit|radialventilator|schalldämpfer|verschlussklappe|verteiler\s*/\s*sammler|betonkernaktivierung|belüftungs(?:kamin|system)|wärmetauscher|warmwasserspeicher|heizkörper|luftkanal|kaltwassersatz|\blu[ft]+gitter",
    "Plumbing fixtures": r"sanitärporzellan|tiefsp(?:ü|ue)l|waschbecken|waschtisch|urinal|sp(?:ü|ue)lkasten|wc-sitz|\bwc\b|brausebatterie|dusch(?:rinne|wanne|kopf|stange)|handtuch(?:halter|spender)|seifenspender|spiegel|papierrollenhalter|brause",
    "Insulation": r"(?:dämm|daemm)(?:ung|platte|stoff|schale)|\b(?:eps|xps|pir|wls)\b|mineralwolle|perimeterdämm|körperschalldämm",
    "Waterproofing": r"dampfsperre|dampfbremse|abdichtungs(?:bahn|folie|masse|stoff)|bitumenbahn|schweißbahn|fugenband|schutzfolie|dicht(?:folie|bahn|schlämme|manschette)|\bepdm\b|\bvlies\b",
    "Aggregates and binders": r"tragschicht|frostschutzschicht|\b(?:frostschutz|kies|sand|splitt|schotter|rollkies|gründungspolster|grubenkies|feinkies|humus)\b|filterkies|stützkies|filtermaterial|filterfüllung|sandbett|kiesbett|wasserbaustein|mischbinder|mineral(?:gemisch|beton)|steinmehl|\bsemidol\b",
    "Road materials": r"asphalt(?:beton|deckschicht|binderschicht|tragschicht|schicht)|bitukies|bitumenemulsion|\btok.band\b|bordstein|pflaster|randstein|rasen(?:samen|mischung|saat)|landschaftsrasen",
    "Precast concrete": r"fertigteil|ft[- ](?:stütze|sockel|binder)|betonfertigteil|sandwichelement|treppenlauf|vorgefertigt",
    "Concrete and reinforcement": r"füllbeton|betonstahl|stahlbeton|bewehrungsstahl|bewehrungsmatte|bewehrung|verfüllbeton|betonauflager|\bbeton\b|\bc\s*\d{1,2}/\d{1,2}\b|zement|mörtel",
    "Wall systems": r"mauerwerk|mauerstein|kalksandstein|porenbeton|gipskarton|\bgk[bf]\b|gipsfaser|metallständerwand|trennwand|wandplatte|unterdecke|deckenplatte",
    "Paint and coatings": r"dispersionsfarbe|latexfarbe|farbe\b|anstrich|lack\b|beschichtung|grundierung|spachtelmasse",
    "Floor finishes": r"bodenbelag|teppich|kautschuk|\bpvc[- ]belag|parkett|linoleum|sockelleiste|ausgleichsmasse|\bestrich\b",
    "Tiles and stone": r"fliese|feinsteinzeug|naturstein|granit|sandstein|terrazzo",
    "Doors and gates": r"türelement|\btür(?:e|blatt|zarge)?\b|stahlzarge|sektionaltor|rolltor|feststellanlage|türschließer",
    "Joinery and furniture": r"fensterbank|schrank|\bhpl\b|\bmdf\b|arbeitsplatte|möbel|schiebetür",
    "Fasteners and metalwork": r"nieten|stahlprofil|profilstahl|befestigungs|montageschiene|\bschraube|\bdübel|anker|stahlblech|blech|\bgeländer|\b(?:steig|edelstahl)leiter|trittstufe|bodenkonsole|\bkonsole",
    "Site equipment": r"sanitärcontainer|\bbauzaun|warnleuchte|verkehrszeichen|bauschild|chemo.toilette|schrankenzaun|absperrschranke|leitbake",
}
PRODUCT_PATTERNS = {category: re.compile(pattern, re.I) for category, pattern in PRODUCT_TERMS.items()}
ADDITIONAL_TERMS = (
    ("Road materials", r"\b(?:sts|fss)\b|\bac\s*\d{1,2}\s*(?:tn|dn)|bitumenh|schotterstraße|kiesbankett|regiosaat|feuchtwiesenmischung|parkplatzrasen|rasen ansäen|dünger"),
    ("Aggregates and binders", r"mutterboden|auffüllsand|sandüberdeckung|kiesfilter|grobschotter|hinterfüllung.{0,18}liefermaterial|bodenaustausch recycling"),
    ("Waterproofing", r"geotextil|(?:noppen|sperr)bahn|\bpe-folie|fugenmasse|abdichtung[ ,].{0,10}(?:bitum|r500)"),
    ("Pipes", r"grundleitung|dränleitung|pp dn\s*\d+\s*sn\b"),
    ("Pipe fittings", r"muffe[n ]|verschlu(?:ss|ß)(?:kappe|stopfen|muffe)|überschiebmuffe|rohrdurchführung|mediendurchführung|\b(?:eu|mma|ff|q|t|u)\s*(?:dn|[- ]?stück)|\b(?:eu|u|x|xg)[ -]+stück|\bbogen dn|\bbögen aus|winkel.{0,20}(?:pe|dn)|klemmverbinder|\bkappe pe\b|pass- und ausbaustück"),
    ("Manholes and covers", r"kabelschacht|revisionsschacht|kontrollschacht|sickerschacht|schachtaufsetzrohr|abzweigschacht"),
    ("Valves and controls", r"rückstauklappe|hydrant|hausanschlussgarnitur"),
    ("Measurement and instrumentation", r"datenlogger|leckageüberwach|potentialanschlussfühler|messdose"),
    ("Electrical equipment", r"warn[ -](?:und ortungs)?band|ortungsband|gerätedose|anschlussdose|\bsim-karte"),
    ("Fasteners and metalwork", r"sicherheitssteigleiter|formstahl|kleineisenteile|maueranschlussschiene|\b(?:half(en)?|ht[au])\b"),
    ("Concrete and reinforcement", r"betonstabstahl|fundamentköchereinsätze|\bstb[,. -].{0,12}c\s*\d{1,2}/\d{1,2}"),
    ("Precast concrete", r"\bft-sattel|flachsturz|treppenpodest"),
    ("Insulation", r"iso-korb|deckenauflager.{0,12}trennstreifen"),
    ("Site equipment", r"schutzzaun|witterungsschutz-zelt|schuttcontainer|(?:arbeits|hebe|modul|fahrbares\s+)gerüst|überbrückungsträger|treppenturm"),
    ("Process gases", r"\b(?:schutzgas|stickstoff)\b"),
    ("Pipe fittings", r"trommelstopfen|abschrumpfmuffe"),
    ("Drainage", r"sickerpackung|kiesfilter|dachdurchführung"),
    ("Electrical equipment", r"warnband|fließpfeile"),
    ("Waterproofing", r"abdichtung.{0,25}(?:sockel|wand|boden)|voranstrich|trennfuge"),
)
ADDITIONAL_PATTERNS = [(category, re.compile(pattern, re.I)) for category, pattern in ADDITIONAL_TERMS]
TIME_UNITS = {"h", "std", "d", "tag", "wo", "st wo", "stwo", "mwo", "m2d", "md", "mt", "monat", "jahr"}
UNITS = {"st": "piece", "stk": "piece", "stck": "piece", "stück": "piece", "m²": "m2",
         "m³": "m3", "to": "t", "std": "h"}
NON_PRODUCT = re.compile(
    r"abbruch|abbrechen|demontage|entsorg|abtransport|abfahren|ausbauen|abbauen|aufbruch|"
    r"reinigen|säubern|spülen|desinfiz|dichtheits|druckprüf|prüfung|prüfen|"
    r"vermessung|dokumentation|nachweis|berechnung|zeichnungen|baudokument|inbetrieb|"
    r"baustelleneinrichtung|baustelle (?:einrichten|räumen)|verkehrssicherung|"
    r"stundenlohn|regiearbeit|vorhalten|montageleiter|facharbeiter|bauhelfer|"
    r"unterfahren|aushub|boden.{0,55}(?:lösen|lagern)|(?:erd|ober)bodenabtrag|"
    r"kernbohr|bohrung herstellen|suchschlitze|kalibrier|anschrägen|abschieben|"
    r"(^|[ ,.])schneiden\b|(?:straßen|asphalt)\w* fräsen|aufstemmen|einmessen|"
    r"^messung|^wartung|^untersuchung|^analyse|rückbau|kamerabefahrung|druckprobe|dichtigkeit|"
    r"lastplattendruck|plattendruckversuch|einweisung|einweisen|planung|bodengutachten|"
    r"ablängung|abstecken|bäume fällen|\b(?:ausgraben|freilegen|ausheben|trennschnitt)\b|"
    r"^fräsen|aufbrechen|asphalt.{0,15}(?:fräsen|abtragen)|"
    r"\b(?:an- und abfahrt|gebrauchsüberlassung|gebühr)\b|"
    r"mitverlegung|längs?e?kreuzung|flügelglätten|entsorgung|meterrisse|dokument|"
    r"wasserandrang|\b(?:baugrube|planum)\b|beweissicherung|^ausbau\b|spülbohrung|"
    r"arbeitssicherheit|spartenpläne|verkehrsrechtliche anordnung|wasseranalys|^schweißverbindung|"
    r"dichtheit|rammsondierung|beprobung|\bwasserhaltung|\bplanieren\b|"
    r"\b(?:lastplattenversuch|wiederausgraben|kernlochbohrung|schlitz(?:e)?|planungsleistung)\b|"
    r"gebühren|entwurfplanung|bestandsplan|wartungsanleitung|\b(?:verdrahtungsplan|messprotokoll)\b|"
    r"\b(?:hand|such)schacht(?:ung|en)?\b|wurzel(?:beh|stock)|nachschneiden|aufnehmen.{0,15}transpor|"
    r"pumpensumpf|^umwickeln\b|\bbaugrubenverbau\b|\bplanierschicht\b|"
    r"^(?:öffnungen?|wanddurchbrüche|schalung|deckenrandschalung)\b|"
    r"tagesunterkünfte|anschlusskosten|betriebsunterbrechung|\bwertungs|abrechnungsunterlagen|"
    r"\bsoftware-update\b|desinfektion|pflichtenheft|\bprüfstatiker\b|technische bearbeitung",
    re.I,
)
SURCHARGE = re.compile(r"\b(?:\w*zulage|zuschlag|mehrkosten|stundenlohn|budget|minderpreis|mehrpreis|nachlass)\b", re.I)
REFERENCED_WORK = re.compile(
    r"^(?:einbau|montage|verlegen|legen|aufbringen|arbeiten an|bestehende?s?)\b|"
    r"\b(?:bauseits|vom ag) (?:beigestellt|geliefert|gestellt)|\bohne lieferung\b", re.I,
)
WORD_SPACE = re.compile(r"\s+")
POSITION = re.compile(r"\d+(?:\.\d+[a-zA-Z]?)*")


@dataclass
class Evidence:
    name: str
    document: UUID
    checksum: str
    kind: str
    locator: dict
    data: dict
    currency: str | None

    @property
    def code(self):
        return self.data.get("code") or ".".join(self.data.get("code_parts") or []) or None

    @property
    def position(self):
        family, _ = COMPANIONS.get(self.name, (self.name, 0))
        original = (self.data.get("code_raw") or "").strip()
        code = LEGACY_POSITION.get((family, original), (self.code or "").strip("."))
        if POSITION.fullmatch(code):
            normalized = ".".join(str(int(part)) if part.isdigit() else part.lower()
                                  for part in code.split("."))
            return f"challenge-a:{family}:{normalized}"
        return f"challenge-a:{self.checksum}:{self.kind}:{json.dumps(self.locator, sort_keys=True)}"


def compact(text):
    return WORD_SPACE.sub(" ", unicodedata.normalize("NFC", text or "")).strip()


def specification(row):
    short = row.data.get("short_description") or ""
    detail = row.data.get("long_description") or ""
    if short.lstrip().startswith("***"):
        short = next((line for line in detail.splitlines()
                      if line.strip() and not line.lstrip().startswith("***")
                      and line.strip() != short.strip("* ")), "")
    description = compact(detail)
    title = re.sub(r"^(?:alternativ:|wie vor,? jedoch,?)\s*", "", compact(short), flags=re.I)
    if title.lower().startswith("leistung wie position") and "jedoch" in description:
        revised = description.partition("jedoch")[2].strip(" ,")
        title = re.split(r"[.;]|, (?:einschl|für|in|zum|zur)\b", revised, maxsplit=1)[0][:160]
    return title, description or title


def category_for(title):
    # The first named product is usually the subject, and later nouns can
    # describe compatible components or the installation location.
    matches = [(match.start(), category)
               for category, pattern in (*PRODUCT_PATTERNS.items(), *ADDITIONAL_PATTERNS)
               if (match := pattern.search(title))]
    return min(matches, key=lambda match: match[0])[1] if matches else None


def classify(position, row, title, description, is_heading):
    if not title or row.kind == "price":
        return "review", None
    if is_heading:
        return "heading", None
    override = PRODUCT_OVERRIDES.get(position.removeprefix("challenge-a:"))
    if override:
        return "installed", override[1]
    tender_unit = compact(row.data.get("unit")).casefold().rstrip(".")
    if tender_unit in TIME_UNITS or SURCHARGE.search(title):
        return "activity", None
    if row.name == "501-24-01_GAEB-XML_sas.x83" and position.rsplit(":", 1)[1] in {
        "4.3.1", "4.3.2", "4.3.3", "4.3.4",
    }:
        return "activity", None
    if position.startswith("challenge-a:an24-0305:"):
        code = position.rsplit(":", 1)[1]
        if code in AN24_SUPPLY:
            if code.startswith("3.1."):
                return "supply", "Pipes"
            if code in {"4.1.10", "4.1.20"}:
                return "supply", "Cable conduits" if code == "4.1.10" else "Control cables"
            category = {
                "7.1.190": "Concrete and reinforcement", "7.1.200": "Road materials", "7.1.210": "Road materials",
            }.get(code, "Aggregates and binders")
            return "supply", category
        if code in {"3.2.10", "3.2.20", "3.2.30", "3.2.40", "3.2.50", "3.2.100", "3.2.110",
                    "3.2.120", "4.1.60", "4.1.70", "4.1.270", "4.1.280", "4.1.290", "4.1.300"}:
            return "activity", None
        if code in {"3.2.390", "3.2.400", "3.2.410", "3.2.420", "5.3.110", "5.3.120"}:
            return "installed", "Valves and controls"
    delivering = re.search(r"\bliefern\b|\blieferung\b", title, re.I)
    if NON_PRODUCT.search(title) or (REFERENCED_WORK.search(title) and not delivering):
        return "activity", None
    category = category_for(title)
    if not category and (delivering or re.search(r"\[(?:PERSON|FIRMA)_\d+\]", title)):
        category = category_for(description[:450])
    if not category:
        trade = re.match(r"LV_(\d+[a-z]?)_", row.name)
        physical_unit = UNITS.get(tender_unit, tender_unit) in {"piece", "m", "m2", "m3", "kg", "t", "satz", "l"}
        if trade and physical_unit and re.search(r"[a-zA-ZäöüÄÖÜ]{3}", title):
            category = TRADE_CATEGORIES.get(trade[1])
        elif position.startswith("challenge-a:8209.003:"):
            chapter = position.rsplit(":", 1)[1].split(".")[0]
            if chapter in {"3", "4", "5", "6", "7"} and physical_unit:
                category = {"3": "Pumps and machinery", "4": "Measurement and instrumentation",
                            "5": "Pipes", "6": "Valves and controls", "7": "Heating and ventilation"}[chapter]
    return ("installed", category) if category else ("review", None)


def load_evidence(connection, project_name):
    projects = connection.execute("SELECT id FROM project WHERE name = %s", (project_name,)).fetchall()
    if len(projects) != 1:
        raise ValueError(f"Expected one imported project named {project_name!r}")
    rows = connection.execute(
        """
        SELECT d.filename, d.id, d.sha256, e.kind, e.locator, e.payload, upper(i.metadata->>'currency')
        FROM source_document d
        CROSS JOIN LATERAL (
            SELECT id, metadata FROM source_import
            WHERE source_document_id = d.id AND status IN ('parsed', 'review')
            ORDER BY imported_at DESC, id DESC LIMIT 1
        ) i
        JOIN source_extract e ON e.import_id = i.id
        WHERE d.project_id = %s AND e.kind IN ('item', 'item_candidate', 'price')
        ORDER BY d.filename, e.ordinal
        """,
        (projects[0][0],),
    )
    evidence = [Evidence(*row) for row in rows]
    if not any(row.name == AN24_PDF and row.checksum == AN24_HASH for row in evidence):
        raise ValueError("The original Challenge A offer AN24-0305 is missing from the import")
    return evidence


def validated_an24_rates(rows):
    pdf = next((r for r in rows if r.name == AN24_PDF and r.kind == "item_candidate"), None)
    legacy = next((r for r in rows if r.name == AN24_D84 and r.kind == "price"), None)
    if pdf is None or legacy is None or pdf.currency != "EUR" or legacy.currency != "EUR":
        return None
    for field in ("unit_price", "quantity", "line_amount"):
        pdf_value, legacy_value = pdf.data.get(field), legacy.data.get(field)
        if pdf_value is None or legacy_value is None or Decimal(pdf_value) != Decimal(legacy_value):
            return None
    return pdf


def import_challenge_catalogue(connection, project_name):
    with connection.transaction():
        connection.execute("SELECT pg_advisory_xact_lock(26641, 2)")
        evidence = load_evidence(connection, project_name)
        grouped = defaultdict(list)
        for row in evidence:
            grouped[row.position].append(row)
        parents = {key.rpartition(".")[0] for key in grouped if key.rpartition(".")[1]}

        known = {}
        for position, product in connection.execute(
            "SELECT DISTINCT position_key, product_id FROM catalogue_source_line WHERE product_id IS NOT NULL"
        ):
            if position in known and known[position] != product:
                raise ValueError(f"Conflicting catalogue products for {position}")
            known[position] = product
        for code, product in connection.execute(
            """
            SELECT pp.source_locator->>'line_code', pp.product_id
            FROM product_price pp JOIN source_document d ON d.id = pp.source_document_id
            WHERE d.sha256 = %s AND pp.price_basis = 'tender_offer'
            """, (AN24_HASH,),
        ):
            if code in AN24_SUPPLY:
                known.setdefault(f"challenge-a:an24-0305:{code}", product)
        categories = dict(connection.execute("SELECT name, id FROM product_category"))
        bidder = connection.execute("SELECT id FROM supplier WHERE name = %s", (AN24_BIDDER,)).fetchone()
        if bidder is None:
            bidder = connection.execute("INSERT INTO supplier (name) VALUES (%s) RETURNING id", (AN24_BIDDER,)).fetchone()

        counts = Counter()
        exact_specs = {}
        links = []
        for position, rows in sorted(grouped.items()):
            row = min(rows, key=lambda r: (not specification(r)[0], COMPANIONS.get(r.name, ("", 0))[1]))
            title, description = specification(row)
            is_heading = position in parents and not row.data.get("unit") and not row.data.get("quantity")
            decision, category = classify(position, row, title, description, is_heading)
            counts[decision] += 1
            product = None
            if category:
                if category not in categories:
                    categories[category] = connection.execute(
                        """
                        INSERT INTO product_category (name) VALUES (%s)
                        ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id
                        """, (category,),
                    ).fetchone()[0]
                # Full specifications can repeat within or across independent source documents.
                # Keep short or context-dependent descriptions separate for review.
                original_unit = compact(row.data.get("unit")).casefold().rstrip(".")
                spec = None
                if decision == "installed" and len(description) >= 70 and "wie vor" not in description[:80].lower():
                    spec = (title.casefold(), description.casefold(), original_unit)
                product = known.get(position) or (exact_specs.get(spec) if spec else None)
                historical = validated_an24_rates(rows) if decision == "supply" else None
                if product is None:
                    override = PRODUCT_OVERRIDES.get(position.removeprefix("challenge-a:"))
                    if override and override[0]:
                        title = override[0]
                    unit = UNITS.get(original_unit, original_unit) if historical else None
                    if position in {"challenge-a:an24-0305:3.1.60", "challenge-a:an24-0305:3.1.70"}:
                        title += " mit integrierter Zugsicherung"
                        description += " Mit integrierter Zugsicherung gemäß Pos. 3.1.50."
                    if position == "challenge-a:an24-0305:4.1.10":
                        description += " Preis pro Laufmeter des Paars."
                    product = connection.execute(
                        """
                        INSERT INTO product (supplier_id, category_id, name, description, unit_code, review_status)
                        VALUES (%s, %s, %s, %s, %s, 'pending') RETURNING id
                        """, (bidder[0] if historical else None, categories[category], title, description, unit or None),
                    ).fetchone()[0]
                    counts["added_products"] += 1
                if spec:
                    exact_specs.setdefault(spec, product)
                if historical:
                    insertion = connection.execute(
                        """
                        INSERT INTO product_price (
                            product_id, valid_from, currency, unit_price, price_basis, source_document_id, source_locator
                        ) VALUES (%s, %s, 'EUR', %s, 'tender_offer', %s, %s)
                        ON CONFLICT (product_id, currency, price_basis, valid_from) DO NOTHING
                        """,
                        (product, AN24_DATE, historical.data["unit_price"], historical.document,
                         jsonb({**historical.locator, "line_code": historical.code})),
                    )
                    counts["added_historical_prices"] += insertion.rowcount
            for source in rows:
                rate = source.data.get("unit_price")
                links.append((
                    source.document, source.kind, jsonb(source.locator), source.code, position, decision, product,
                    source.data.get("unit"), rate, source.currency if rate is not None else None,
                ))
        with connection.cursor() as cursor:
            cursor.executemany(
                """
                INSERT INTO catalogue_source_line (
                    source_document_id, source_kind, source_locator, source_line_code,
                    position_key, decision, product_id, tender_unit, rate_amount, rate_currency
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (source_document_id, source_kind, source_locator) DO NOTHING
                """, links,
            )
            counts["added_source_rows"] = cursor.rowcount
        return {"documents": len({row.document for row in evidence}), "source_rows": len(evidence),
                "positions": len(grouped), "decisions": dict(counts)}
