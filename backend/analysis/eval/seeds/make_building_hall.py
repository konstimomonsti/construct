"""Writes building_hall.json, the clean synthetic seed of the evaluation.

    python -m analysis.eval.seeds.make_building_hall            # rewrites building_hall.json

A small training hall with an office wing, tendered as one package: earthworks, concrete, screed,
drywall, painting and a flat roof. About 60 hand-written lines in German, priced, with these properties:

* every layer 2 dependency of the five trades is present exactly once (one line names it), so the clean
  seed gives 0 layer 2 findings, and removing that one line makes the check fire;
* no short text names a trigger of another trade, and no long text names a dependency of any trade, so
  that planted changes have no side effects;
* long texts state how the line is measured ("Abrechnung nach m2"), so unit mutations are detectable;
* line amounts, subtotals and the net total are consistent, so the clean seed gives 0 layer 1 findings.

The text is the source of truth; the amounts are computed here so that they cannot drift.
"""

from __future__ import annotations

from decimal import Decimal as D
from pathlib import Path

from .. import docio

SEED_FILE = Path(__file__).with_name("building_hall.json")

# (code, title). A section's parent is the code without its last part.
SECTIONS = [
    ("00", "Baustelle"),
    ("00.01", "Baustelleneinrichtung und Gerüst"),
    ("00.02", "Entsorgung und Reinigung"),
    ("01", "Erd- und Betonarbeiten"),
    ("01.01", "Erdarbeiten"),
    ("01.02", "Gründung und Bodenplatte"),
    ("01.03", "Aufgehende Bauteile"),
    ("01.04", "Schalung und Bewehrung"),
    ("02", "Estricharbeiten"),
    ("02.01", "Untergrund und Dämmung"),
    ("02.02", "Estrich"),
    ("02.03", "Beläge und Sockel"),
    ("03", "Trockenbauarbeiten"),
    ("03.01", "Wände"),
    ("03.02", "Dämmung, Spachtelung und Zubehör"),
    ("04", "Malerarbeiten"),
    ("04.01", "Vorbereitung"),
    ("04.02", "Anstriche und Beschichtung"),
    ("05", "Dachabdichtung"),
    ("05.01", "Dachaufbau"),
    ("05.02", "Details und Entwässerung"),
]

PSCH = "psch"

# (section, item number, short text, long text, quantity, unit as written in a GAEB file, unit price)
ROWS = [
    # 00 Baustelle
    ("00.01", "0010", "Baustelleneinrichtung einrichten, vorhalten und räumen",
     "Baustelleneinrichtung für alle Leistungen des Bauvorhabens einrichten, während der Bauzeit vorhalten und "
     "nach Abschluss räumen, einschließlich Bauzaun und Containeranlage. Abrechnung pauschal.",
     "1", PSCH, "18500.00"),
    ("00.01", "0020", "Fahrbares Arbeitsgerüst, Arbeitshöhe bis 4 m, vorhalten",
     "Fahrbare Arbeitsgerüste für die Innenausbauarbeiten stellen, umsetzen und vorhalten, Standsicherheit nach "
     "Herstellerangabe nachweisen.",
     "16", "Wo", "120.00"),
    ("00.01", "0030", "Baustrom und Bauwasser bereitstellen",
     "Anschlussstellen für Baustrom und Bauwasser herstellen, Verbrauch trägt der Auftragnehmer. "
     "Abrechnung pauschal.",
     "1", PSCH, "4200.00"),
    ("00.01", "0040", "Bauschild nach Vorgabe des Bauherrn",
     "Bauschild liefern, aufstellen und nach Bauende wieder abbauen. Abrechnung nach Stück.",
     "1", "St", "380.00"),
    ("00.02", "0010", "Bauschutt und Verpackungsabfälle entsorgen",
     "Anfallende Baustellenabfälle sortenrein trennen, laden, abfahren und ordnungsgemäß entsorgen, Nachweise "
     "vorlegen. Abrechnung nach t.",
     "22", "t", "96.00"),
    ("00.02", "0020", "Bauendreinigung",
     "Gebäude und Außenflächen besenrein und gebrauchsfertig übergeben, Verglasungen und Bodenflächen feucht "
     "reinigen. Abrechnung pauschal.",
     "1", PSCH, "3400.00"),
    # 01 Erd- und Betonarbeiten
    ("01.01", "0010", "Oberboden abtragen und seitlich lagern",
     "Oberboden im Bereich des Baufeldes bis 30 cm Tiefe abtragen und auf dem Grundstück zur Wiederverwendung "
     "lagern. Abrechnung nach m2.",
     "1150", "m2", "3.80"),
    ("01.01", "0020", "Baugrubenaushub, Bodenklasse 3 bis 5",
     "Baugrube und Fundamentgräben lösen, laden und seitlich lagern, Böschungen nach DIN 4124 herstellen. "
     "Abrechnung nach m3.",
     "1480", "m3", "9.60"),
    ("01.01", "0030", "Planum herstellen und verdichten",
     "Planum profilgerecht abziehen und mit schwerem Gerät verdichten, Höhentoleranz 2 cm. Abrechnung nach m2.",
     "900", "m2", "1.80"),
    ("01.01", "0040", "Tragschicht aus Schotter 0/45, d = 30 cm",
     "Schottertragschicht auf dem Planum liefern, einbauen und verdichten, Ev2 mindestens 100 MN/m2. "
     "Abrechnung nach m2.",
     "900", "m2", "21.50"),
    ("01.01", "0050", "Arbeitsraum mit Kies verfüllen und verdichten",
     "Arbeitsraum lagenweise mit Kies verfüllen und verdichten, Material aus Lieferung. Abrechnung nach m3.",
     "320", "m3", "28.00"),
    ("01.01", "0060", "Überschüssigen Aushub abfahren und deponieren",
     "Nicht wiederverwendbaren Bodenaushub laden, abfahren und auf zugelassener Deponie entsorgen, Wiegescheine "
     "vorlegen. Abrechnung nach m3.",
     "780", "m3", "22.00"),
    ("01.02", "0010", "Sauberkeitsschicht aus Beton C8/10, d = 10 cm",
     "Sauberkeitsschicht auf dem verdichteten Planum herstellen, abgezogen und eben. Abrechnung nach m2.",
     "900", "m2", "13.80"),
    ("01.02", "0020", "Streifenfundamente aus Stahlbeton C25/30, XC2",
     "Streifenfundamente herstellen, Beton C25/30 liefern, einbauen, verdichten und nachbehandeln. Abrechnung nach m3.",
     "68", "m3", "214.00"),
    ("01.02", "0030", "Bodenplatte aus Stahlbeton C30/37, d = 30 cm",
     "Bodenplatte d = 30 cm als WU-Konstruktion herstellen, Beton C30/37 liefern, einbauen, verdichten, abziehen und "
     "nachbehandeln. Abrechnung nach m3.",
     "264", "m3", "238.00"),
    ("01.02", "0040", "Betonoberfläche der Hallenfläche mit Flügelglätter abziehen",
     "Frische Betonoberfläche maschinell glätten und für die spätere Beschichtung vorbereiten. "
     "Abrechnung nach m2.",
     "640", "m2", "4.60"),
    ("01.03", "0010", "Stützen aus Stahlbeton C30/37, 40 x 40 cm",
     "Stützen herstellen, Beton C30/37 liefern, einbauen, verdichten und nachbehandeln. Abrechnung nach m3.",
     "24", "m3", "395.00"),
    ("01.03", "0020", "Wände aus Stahlbeton C25/30, d = 25 cm",
     "Wände herstellen, Beton C25/30 liefern, einbauen, verdichten und nachbehandeln. Abrechnung nach m3.",
     "52", "m3", "318.00"),
    ("01.03", "0030", "Decke über Erdgeschoss aus Stahlbeton C30/37, d = 24 cm",
     "Flachdecke herstellen, Beton C30/37 liefern, einbauen, verdichten und nachbehandeln. Abrechnung nach m3.",
     "58", "m3", "292.00"),
    ("01.03", "0040", "Attika aus Stahlbeton C25/30, d = 20 cm",
     "Umlaufende Attika herstellen, Beton C25/30 liefern, einbauen, verdichten und nachbehandeln. Abrechnung nach m3.",
     "16", "m3", "340.00"),
    ("01.04", "0010", "Schalung für Wände, Stützen und Decken, Sichtbetonklasse SB2",
     "Schalung liefern, vorhalten, herstellen und nach Erhärtung des Betons entfernen. Abrechnung nach m2.",
     "820", "m2", "43.00"),
    ("01.04", "0020", "Betonstahl BSt 500 S, geschnitten, gebogen und verlegt",
     "Betonstahl liefern, schneiden, biegen und nach Plan verlegen, einschließlich Abstandhalter. "
     "Abrechnung nach t.",
     "41", "t", "1380.00"),
    ("01.04", "0030", "Aussparungen und Einbauteile in Betonbauteilen",
     "Aussparungen, Hülsen und Ankerschienen nach Plan setzen und sichern. Abrechnung nach Stück.",
     "36", "St", "28.00"),
    # 02 Estricharbeiten
    ("02.01", "0010", "Untergrundvorbereitung mit Tiefgrund",
     "Betonuntergrund schleifen, reinigen und mit Tiefgrund haftfest vorbereiten, Verbrauch nach "
     "Herstellerangabe. Abrechnung nach m2.",
     "150", "m2", "3.40"),
    ("02.01", "0020", "Randdämmstreifen, PE-Schaum, h = 100 mm, d = 8 mm",
     "Randdämmstreifen an allen aufgehenden Bauteilen und Durchdringungen setzen, Folienlasche überstehend. "
     "Abrechnung nach m.",
     "190", "m", "2.10"),
    ("02.01", "0030", "Trittschalldämmung, Polystyrol-Hartschaum TSD 30-2, d = 30 mm",
     "Platten dicht gestoßen und versetzt verlegen, Durchdringungen sauber anpassen. Abrechnung nach m2.",
     "390", "m2", "8.90"),
    ("02.02", "0010", "Zementestrich CT-C25-F4, schwimmend, d = 65 mm",
     "Estrich d = 65 mm liefern, einbauen, verdichten, abziehen und nachbehandeln, Oberfläche für Belagarbeiten geeignet. "
     "Abrechnung nach m2.",
     "240", "m2", "31.50"),
    ("02.02", "0020", "Zementestrich CT-C30-F5 im Verbund, d = 45 mm",
     "Verbundestrich auf vorbereitetem Betonuntergrund einbauen, abziehen und glätten. Abrechnung nach m2.",
     "150", "m2", "27.80"),
    ("02.03", "0010", "Kautschukboden, d = 3 mm, Noppenstruktur",
     "Kautschukbelag verlegen und verkleben, Nähte verschweißen, Farbe nach Bemusterung. Abrechnung nach m2.",
     "390", "m2", "46.00"),
    ("02.03", "0020", "Sockelleiste, Aluminium, H = 60 mm",
     "Sockelleisten liefern und befestigen, Ecken und Stöße sauber ausbilden. Abrechnung nach m.",
     "210", "m", "7.80"),
    ("02.03", "0030", "Dehnungsfugenprofil, Aluminium, Höhe 65 mm",
     "Bewegungsfugenprofil in Estrich und Belag nach Fugenplan einbauen. Abrechnung nach m.",
     "38", "m", "24.00"),
    ("02.03", "0040", "Übergangsprofil, Edelstahl, Breite 30 mm",
     "Übergangsprofil an Belagwechseln und Türschwellen befestigen. Abrechnung nach m.",
     "14", "m", "19.00"),
    # 03 Trockenbauarbeiten
    ("03.01", "0010", "Metallständerwand, d = 100 mm, 2 x GKB 12,5 mm, F30",
     "Ständerwerk aus CW-Profilen, beidseitig zweilagig beplankt, Anschlüsse an Boden, Decke und Wände. "
     "Abrechnung nach m2.",
     "420", "m2", "54.50"),
    ("03.01", "0020", "Vorsatzschale GKF, d = 62,5 mm",
     "Vorsatzschale freistehend mit CD-Profilen, einlagig beplankt. Abrechnung nach m2.",
     "60", "m2", "41.00"),
    ("03.01", "0030", "Stahlumfassungszarge für Wanddicke 100 mm",
     "Zarge einbauen, hinterfüllen und ausrichten. Abrechnung nach Stück.",
     "9", "St", "168.00"),
    ("03.01", "0040", "Anschluss Ständerwand an Bestandsdecke gleitend",
     "Gleitender Deckenanschluss mit Profil und Trennstreifen. Abrechnung nach m.",
     "120", "m", "6.50"),
    ("03.02", "0010", "Mineralwolle-Einlage, d = 60 mm, nichtbrennbar",
     "Hohlraum der Ständerwände vollflächig ausfüllen, Stöße dicht stoßen. Abrechnung nach m2.",
     "480", "m2", "6.40"),
    ("03.02", "0020", "Spachtelung der Plattenstöße, Qualitätsstufe Q2",
     "Plattenstöße und Schraubenköpfe verspachteln und schleifen. Abrechnung nach m2.",
     "480", "m2", "4.20"),
    ("03.02", "0030", "Eckschutzschiene, verzinkt, einbauen",
     "Eckschutzschienen an Außenecken einbauen und einbetten. Abrechnung nach m.",
     "64", "m", "5.60"),
    ("03.02", "0040", "Revisionsklappe, 30 x 30 cm, Trockenbau",
     "Revisionsklappe in Wand oder Decke einbauen, bündig mit der Plattenfläche. Abrechnung nach Stück.",
     "8", "St", "72.00"),
    ("03.02", "0050", "Aussteifungsprofile für Wandkonsolen",
     "Zusätzliche Aussteifungsprofile im Ständerwerk für Konsolen einbauen. Abrechnung nach Stück.",
     "14", "St", "18.50"),
    ("03.02", "0060", "Schattenfugenprofil, Aluminium, schwarz",
     "Schattenfugenprofil am Wand-Decken-Anschluss einbauen und ausrichten. Abrechnung nach m.",
     "70", "m", "9.80"),
    # 04 Malerarbeiten
    ("04.01", "0010", "Abdeckarbeiten für Malerarbeiten",
     "Böden und Einbauteile mit Vlies schützen, Schutz nach Arbeitsende entfernen. Abrechnung pauschal.",
     "1", PSCH, "2800.00"),
    ("04.01", "0020", "Tiefengrund auf saugenden Untergründen",
     "Tiefengrund gleichmäßig auftragen, Trocknungszeit einhalten. Abrechnung nach m2.",
     "1390", "m2", "1.45"),
    ("04.01", "0030", "Kleinere Fehlstellen schleifen und ausbessern",
     "Risse, Löcher und Unebenheiten in Wand und Decke fachgerecht verschließen und schleifen. "
     "Abrechnung nach m2.",
     "1390", "m2", "1.20"),
    ("04.02", "0010", "Wandflächen mit Dispersionsfarbe streichen, zweimal",
     "Wandflächen innen deckend streichen, Nassabriebklasse 2. Abrechnung nach m2.",
     "1150", "m2", "4.90"),
    ("04.02", "0020", "Deckenfläche mit Silikatfarbe",
     "Deckenflächen innen zweimal streichen, Farbton weiß. Abrechnung nach m2.",
     "240", "m2", "6.10"),
    ("04.02", "0030", "Epoxidharzbeschichtung Hallenboden, rutschhemmend R10",
     "Hallenfläche mit zweikomponentiger Beschichtung versiegeln, Quarzsand eingestreut. Abrechnung nach m2.",
     "640", "m2", "28.50"),
    ("04.02", "0040", "Lackierarbeiten an Stahlzargen",
     "Stahlzargen allseitig lackieren, Farbton nach RAL. Abrechnung nach Stück.",
     "9", "St", "48.00"),
    ("04.02", "0050", "Farbmuster anlegen und zur Freigabe vorlegen",
     "Bemusterung der Farbtöne an der Wand, Freigabe durch die Bauleitung abwarten. Abrechnung nach Stück.",
     "4", "St", "85.00"),
    # 05 Dachabdichtung
    ("05.01", "0010", "Bitumenvoranstrich auf der Betondecke",
     "Voranstrich gleichmäßig auftragen und ablüften lassen. Abrechnung nach m2.",
     "900", "m2", "1.60"),
    ("05.01", "0020", "Dampfsperre, Bitumenschweißbahn mit Aluminiumeinlage",
     "Dampfsperre vollflächig auf der Betondecke verlegen, Stöße verschweißen, an Aufkantungen hochziehen. "
     "Abrechnung nach m2.",
     "900", "m2", "11.40"),
    ("05.01", "0030", "Wärmedämmung, PIR-Hartschaum, d = 160 mm",
     "Dämmplatten zweilagig mit versetzten Stößen verlegen. Abrechnung nach m2.",
     "900", "m2", "38.00"),
    ("05.01", "0040", "Trennlage Glasvlies, 120 g/m2",
     "Trennlage lose verlegen, Überlappung 5 cm. Abrechnung nach m2.",
     "900", "m2", "1.90"),
    ("05.01", "0050", "Dachabdichtung, einlagig, FPO-Dachbahn, d = 1,8 mm",
     "Kunststoff-Dachbahn mechanisch befestigt verlegen, Nähte heißluftverschweißen, Brandverhalten nach "
     "DIN 4102-7. Abrechnung nach m2.",
     "900", "m2", "29.50"),
    ("05.02", "0010", "Attikaanschluss, hochgezogen, Höhe bis 50 cm",
     "Abdichtung an der Attika hochziehen und mit Klemmprofil sichern. Abrechnung nach m.",
     "130", "m", "18.50"),
    ("05.02", "0020", "Dachgully mit Notüberlauf, DN 100",
     "Dachablauf DN 100 mit Laubfang und beheiztem Anschluss einbauen, Notüberlauf nach Fachplanung. "
     "Abrechnung nach Stück.",
     "8", "St", "285.00"),
    ("05.02", "0030", "Dachrandabschlussprofil, Aluminium, eloxiert",
     "Randprofil befestigen und anschließen, Stöße mit Dehnungsausgleich. Abrechnung nach m.",
     "130", "m", "31.00"),
    ("05.02", "0040", "Kiesstreifen am Dachrand mit Rundkies 16/32",
     "Kiesstreifen mit Rundkies einbauen, Breite 50 cm, Kiesfangleiste vorhalten. Abrechnung nach m.",
     "130", "m", "12.00"),
    ("05.02", "0050", "Anschlagpunkte für Absturzsicherung",
     "Anschlagpunkte nach DIN EN 795 auf der Dachfläche montieren und anschließen. Abrechnung nach Stück.",
     "6", "St", "245.00"),
]


def build() -> dict:
    sections = []
    for order, (code, title) in enumerate(SECTIONS):
        parts = code.split(".")
        sections.append({
            "id": f"S{code}", "parent_id": f"S{'.'.join(parts[:-1])}" if len(parts) > 1 else None,
            "code": code, "code_parts": parts, "title": title, "sort_order": order, "stated_total": None,
        })
    lines = []
    for order, (section, number, short, long, quantity, unit, price) in enumerate(ROWS):
        code = f"{section}.{number}"
        lump = unit == PSCH
        lines.append({
            "id": f"L{code}", "code": code, "code_parts": code.split("."), "section_id": f"S{section}",
            "sort_order": order, "short_text": short, "long_text": long, "quantity": D(quantity), "unit": unit,
            "pricing_basis": "lump_sum" if lump else "unit_rate",
            "gaeb_flags": {"LumpSumItem": "Yes"} if lump else {},
            "source_amounts": {"unit_price": D(price), "line_amount": None},
        })
    doc = {
        "project": {"name": "Schulungshalle mit Bürotrakt (synthetischer Seed)", "currency": "EUR",
                    "gaeb_phase": "83"},
        "bom": {"title": "Rohbau und Ausbau Schulungshalle", "stated_net_total": None},
        "sections": sections,
        "lines": lines,
    }
    docio.consistent_amounts(doc)
    return doc


def main() -> int:
    doc = build()
    docio.dump(doc, SEED_FILE)
    print(f"{SEED_FILE}: {len(doc['lines'])} lines, {len(doc['sections'])} sections, "
          f"net total {doc['bom']['stated_net_total']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
