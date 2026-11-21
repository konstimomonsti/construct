from decimal import Decimal

import pytest

from analysis.adapter import from_data
from analysis.runner import analyze


RULE = "L1.QTY.WRITTEN_CONFLICT"


def bill(text, unit, quantity="10", *, heading="Leitplanke montieren", legacy=False):
    return from_data({"project": {"source_document": {"format": "gaeb_1990" if legacy else "json"}},
                      "lines": [{"id": "item", "code": "01.0010", "short_text": heading, "long_text": text,
                                 "quantity": quantity, "unit": unit, "source_locator": {"row": 2}}]})


def findings(snapshot):
    return [finding for finding in analyze(snapshot, [1, 2]).findings if finding.rule_id == RULE]


@pytest.mark.parametrize("text,unit,quantity,expected", [
    ("Gesamtmenge: 13 m.", "m", "10", "13"),
    ("Abrechnungsmenge = 1.250,00 m.", "m", "1200", "1250"),
    ("Positionsmenge: 120 cm.", "m", "10", "1.2"),
    ("Positionsmenge = Produkt aus\n3 m (Vorhaltemenge)\nmal 4 Wochen (Vorhaltedauer).", "mWo", "10", "12"),
    ("Positionsmenge = Produkt aus 250 cm mal 4 Wochen.", "mWo", "8", "10"),
    ("Herstellen für die Entwässerung, vorhalten, Positionsmenge = Produkt aus 30 m mal 28 Wochen.",
     "mWo", "800", "840"),
])
def test_reports_source_amount_and_both_sides(text, unit, quantity, expected):
    finding, = findings(bill(text, unit, quantity))
    cited, = finding.evidence["written_quantities"]
    assert finding.severity == "error" and finding.target.field == "quantity"
    assert finding.source_locator == {"row": 2} and cited["quote"] in text
    assert Decimal(cited["quantity"]) == Decimal(expected)
    assert Decimal(finding.evidence["quantity"]) == Decimal(quantity)
    assert finding.suggested_fix and not finding.suggested_fix.operations


@pytest.mark.parametrize("text,unit,quantity", [
    ("Positionsmenge: 1.250 m.", "m", "100"),
    ("Positionsmenge: 1000 cm.", "m", "10"),
    ("3 m Rohr im Bestand. Dicke 4 cm.", "m", "10"),
    ("Gesamtmenge: ca. 7 m.", "m", "10"),
    ("Optional: Gesamtmenge: 7 m.", "m", "10"),
    ("Trennwände, je Abschnitt, Gesamtmenge: 7 m.", "m", "10"),
    ("Gesamtmenge: 7 m\nje Wohnung.", "m", "10"),
    ("Gesamtmenge: 7 m oder 10 m.", "m", "10"),
    ("Positionsmenge: 1 bis 7 m.", "m", "10"),
    ("Positionsmenge = Produkt aus 4 St mal 20 Tage.", "h", "90"),
    ("Positionsmenge = Produkt aus 4 m mal 2 Tage.", "mWo", "4"),
    ("Positionsmenge = Produkt aus 4 m mal (Vorhaltemenge) mal 2 Wochen.", "mWo", "4"),
    ("Positionsmenge = Produkt aus 4 m mal 2 Wochen\nfür jedes Teil.", "mWo", "4"),
])
def test_ambiguous_or_equivalent_quantities_do_not_disagree(text, unit, quantity):
    assert not findings(bill(text, unit, quantity))


def test_legacy_text_wrapper_is_preserved_in_quote():
    quote = "Positionsmenge = Produkt aus [\n30 m ] ]\n(Vorhaltemenge)\n[TA12 mal [\n28 Wochen ] ]\n(Vorhaltedauer)"
    finding, = findings(bill(f"[TA11 {quote}.", "mWo", "800", legacy=True))
    cited, = finding.evidence["written_quantities"]
    assert cited["quote"] == quote
    assert cited["factors"] == {"amount": "30", "unit": "m", "duration": "28", "duration_unit": "week"}
    assert Decimal(cited["quantity"]) == 840


def test_written_quantity_conflict_blocks_layer_two_shortfall_fix():
    snapshot = from_data({"lines": [
        {"id": "toilet", "code": "01.0010", "short_text": "Tiefspül-WC", "long_text": "Positionsmenge: 6 St.",
         "quantity": "10", "unit": "St"},
        {"id": "seat", "code": "01.0020", "short_text": "WC-Sitz", "quantity": "3", "unit": "St"},
    ]})
    report = analyze(snapshot, [1, 2])
    finding, = [f for f in report.findings if f.rule_id == "L2.SANITARY.WC_NEEDS_WC_SEAT"]
    assert finding.evidence["reason"] == "quantity_not_assessable"
    assert not finding.suggested_fix or not finding.suggested_fix.operations
