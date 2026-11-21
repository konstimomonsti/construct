import pytest

from test_layer1 import make_line, run


def selected(short, long="", unit="ea"):
    result = run(make_line(short_text=short, long_text=long, unit=unit))
    assert not result.errors
    return [f for f in result.findings if f.rule_id in {"L1.PRECAST.LAYER_SUM", "L1.UNIT.TRADE_MISMATCH"}]


@pytest.mark.parametrize("insulation,total,expected", [("8", "30", False), ("10", "30", True),
                                                        ("8,1", "30", False), ("8,11", "30", True)])
def test_layer_math_tolerance(insulation, total, expected):
    findings = selected("FT-Sockel Sandwich", f"d={total}cm gesamt.\nDicke Vorsatzschale: 7 cm\n"
                        f"Dicke Tragschale: 15 cm\nDämmschicht: XPS, WLG 035, d= {insulation} cm")
    assert bool(findings) is expected
    if expected:
        assert findings[0].severity == "error"
        assert findings[0].evidence["bieterfrage_de"].startswith("Zu Pos.")


def test_layer_math_units_and_incomplete_values():
    assert selected("Sandwichelement", "d=0,3m gesamt\nVorsatzschale: 70 mm\nTragschale: 150 mm\nDämmschicht: 80 mm") == []
    assert selected("Sandwichelement", "d=30cm gesamt\nVorsatzschale: 7 cm\nTragschale: 15 cm") == []


@pytest.mark.parametrize("text,good,bad", [
    ("Sandwichelement", "m²", "t"), ("FT-Sockel", "m", "kg"), ("Betonstahl", "t", "m"),
    ("Zulage Aussparung", "ea", "m"), ("Zulage Öffnung", "ea", "m²"),
    ("Halfenschiene", "m", "kg"), ("Ankerschiene", "ea", "t"), ("Einbauteil", "ea", "m²"),
    ("Werkstattpläne", "lump_sum", "m"), ("Montagepläne", "h", "m²"),
])
def test_trade_units(text, good, bad):
    assert selected(text, unit=good) == []
    findings = selected(text, unit=bad)
    assert len(findings) == 1 and findings[0].rule_id == "L1.UNIT.TRADE_MISMATCH"


def test_long_text_mentions_do_not_reclassify():
    assert selected("Abdichtung", "Betonstahl und Sandwichplattenanker", "m²") == []


def test_layer_labels_dämmstoffdicke_and_gesamtdicke():
    text = ("Sandwichelement, Gesamtdicke 30 cm. Dicke Vorsatzschale: 7 cm; Dicke Tragschale: 15 cm; "
            "Dämmstoffdicke: {} cm.")
    assert not selected("FT-Sockel Sandwich", text.format(8))
    assert [f.rule_id for f in selected("FT-Sockel Sandwich", text.format(10))] == ["L1.PRECAST.LAYER_SUM"]


@pytest.mark.parametrize("short,unit", [("Abdeckarbeiten, Böden und Einbauteile schützen", "lump_sum"),
                                        ("Schutzabdeckung für Betonstahl und Halfenschienen", "lump_sum")])
def test_later_mentions_do_not_classify_the_item(short, unit):
    assert not selected(short, unit=unit)


def test_element_code_prefix_still_classifies():
    assert [f.rule_id for f in selected("FS 01: FT-Sockel, Sandwichelement", unit="kg")] == ["L1.UNIT.TRADE_MISMATCH"]


@pytest.mark.parametrize("text,unit,item_name,expected", [
    ("Zulage Aussparung", "m", "Zulage für Aussparungen/Öffnungen", "St"),
    ("Betonstahl", "m", "Betonstahl", "t, kg"),
    ("Werkstattpläne", "m", "Werkstatt- und Montagepläne", "psch, h"),
])
def test_trade_unit_finding_uses_readable_names_and_tender_units(text, unit, item_name, expected):
    [found] = selected(text, unit=unit)
    assert item_name in found.message and item_name in found.evidence["bieterfrage_de"]
    assert f"expected {expected}" in found.message
    assert f"(üblich: {expected})" in found.evidence["bieterfrage_de"]
    assert "opening_surcharge" not in found.message + found.evidence["bieterfrage_de"]


def test_trade_unit_question_keeps_raw_area_notation():
    [found] = selected("Zulage Öffnung", unit="m²")
    assert " in m2 beabsichtigt" in found.evidence["bieterfrage_de"]
    assert "(üblich: St)" in found.evidence["bieterfrage_de"]
