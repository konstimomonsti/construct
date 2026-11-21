"""Regenerate the synthetic precast seed from the read-only LV_11 fixture."""

import json
from pathlib import Path


HERE = Path(__file__).resolve().parent
FIXTURE = HERE.parents[1] / "tests" / "fixtures" / "lv11_precast.json"


def build():
    doc = json.loads(FIXTURE.read_text(encoding="utf-8"))
    doc["project"] = {"name": "Synthetisches LV 11 – Stahlbetonfertigteile", "gaeb_phase": "83", "currency": "EUR"}
    doc["bom"] = {"title": "LV 11 – Stahlbetonfertigteile (synthetisch)", "stated_net_total": None}
    units = {"lump_sum": "psch", "ea": "St", "m": "m", "t": "t"}
    for line in doc["lines"]:
        line.pop("source_locator", None)
        line.pop("unit_raw", None)
        line.pop("quantity_raw", None)
        line["unit"] = units[line["unit"]]
        if line["unit"] == "psch":
            line["gaeb_flags"] = {"LumpSumItem": "Yes"}
        code = line["code"]
        if code in {"3.2.20", "3.2.30", "3.2.40", "3.2.50", "3.2.60"}:
            length = line["short_text"].split("l=")[-1].strip()
            line["short_text"] = line["short_text"].split(", l=")[0] + ", C35/45"
            line["long_text"] = (
                f"Stahlbetonfertigteil als Sandwichelement aus Beton C35/45, Expositionsklasse XC4 und XF4. "
                f"Länge {length}, Höhe 60 cm, Gesamtdicke 30 cm. "
                "Dicke Vorsatzschale: 7 cm; Dicke Tragschale: 15 cm; Dämmstoffdicke: 8 cm. "
                "Wärmedämmung aus extrudierten Polystyrol-Hartschaumplatten. "
                "Sichtbeton der Vorsatzschale durchgefärbt in RAL 7032. "
                "Werkseitige Herstellung einschließlich Bewehrung und Transportanker; Montage auf der Baustelle."
            )
        elif code == "3.2.70":
            line["long_text"] = (
                "Betonstahl 500 S und 500 M für die Ortbetonanschlüsse auf der Baustelle verlegen. "
                "Werkseitige Bewehrung ist in den Fertigteilpositionen enthalten."
            )
        elif code == "3.2.80":
            line.update(unit="St", short_text="Zulage für Aussparungen in den Fertigteilen",
                        long_text="Zulage für Aussparungen bis zu einer Breite von 1,10 m. Abrechnung nach St.")
        elif code == "3.2.90":
            line.update(short_text="Einbauteil aus Edelstahl, Länge 150 mm",
                        long_text="Einbauteil Typ S150 aus Edelstahl liefern und werkseitig einbauen.")
    for code, short, detail, qty, unit in [
        ("3.2.100", "Dichtstoff für Plattenfugen", "Plattenfugen nach Montage mit elastischem Dichtstoff schließen.", "45", "m"),
        ("3.2.110", "Baustellenverkehr sichern", "Verkehrsführung entlang der Zufahrt sicherstellen.", "20", "m"),
    ]:
        doc["lines"].append({
            "id": "lv11-" + code, "code": code, "code_parts": code.split("."), "section_id": "s-3.2",
            "sort_order": len(doc["lines"]), "short_text": short, "long_text": detail,
            "quantity": qty, "unit": unit,
        })
    return doc


if __name__ == "__main__":
    (HERE / "precast_lv11.json").write_text(json.dumps(build(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
