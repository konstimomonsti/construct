import pytest

from test_layer1 import make_line, run


def selected(rule, short, long="", phase="83"):
    result = run(make_line(short_text=short, long_text=long), phase=phase)
    assert not result.errors
    return [f for f in result.findings if f.rule_id == f"L1.TEXT.{rule}"]


@pytest.mark.parametrize("text", ["Fabrikat [FIRMA_095]", "[KENNZEICHEN_005]", "Widerstandsklasse: ---", "Fabrikat: ……", "Typ XXX"])
def test_placeholders(text):
    finding, = selected("SPEC_PLACEHOLDER", text)
    assert finding.evidence["kind"] == "placeholder"
    assert finding.evidence["bieterfrage_de"].startswith("Zu Pos. 01.0001:")


@pytest.mark.parametrize("phase", ["83", "84", "86"])
def test_bidder_blanks_stay_with_existing_rule(phase):
    text = "Vom Bieter einzutragen: Fabrikat: ........"
    assert selected("SPEC_PLACEHOLDER", text, phase=phase) == []
    findings = selected("BIDDER_INPUT", text, phase=phase)
    assert findings[0].severity == ("info" if phase == "83" else "warning")
    assert selected("SPEC_PLACEHOLDER", "Fabrikat: Beispiel", phase=phase) == []


@pytest.mark.parametrize("text", ["d=? 30cm", "l=?", "Dicke: 20/30 cm", "d=20 cm oder 30 cm", "l=30m?"])
def test_unclear_dimensions(text):
    assert len(selected("UNCLEAR_DIMENSION", text)) == 1
    assert selected("UNCLEAR_DIMENSION", "d=30cm; l=7,0 m; Rückfragen?") == []


@pytest.mark.parametrize("short,long,family,severity", [
    ("C20/25", "C25/30", "concrete", "warning"), ("DN 100", "DN125", "DN", "info"),
    ("T30", "T90", "fire", "warning"), ("IP44", "IP65", "IP", "warning"),
    ("GKB", "GKBI", "board", "warning"), ("l=1m", "Länge: 200cm", "length", "warning"),
    ("d=20mm", "Dicke: 3cm", "thickness", "warning"),
])
def test_value_conflicts(short, long, family, severity):
    finding, = selected("VALUE_CONFLICT", short, long)
    assert finding.evidence["family"] == family and finding.severity == severity
    assert selected("VALUE_CONFLICT", short, long + " " + short) == []


def test_normalized_values_and_unlabelled_numbers():
    assert selected("VALUE_CONFLICT", "C 35 / 45 d=30cm l=1m", "C35/45 Dicke: 300mm Länge: 100 cm") == []
    assert selected("VALUE_CONFLICT", "20 mm", "30 mm") == []


def test_missing_self_and_previous_references():
    assert selected("REFERENCE_UNRESOLVED", "siehe auch Pos. 6.1.80")
    assert selected("REFERENCE_UNRESOLVED", "siehe Pos. 01.0001")
    assert selected("REFERENCE_UNRESOLVED", "wie vor")
    result = run(make_line(1), make_line(2, short_text="siehe Pos. 1.1"),
                 make_line(3, short_text="wie vor"), make_line(4, short_text="wie Position zuletzt"))
    assert not any(f.rule_id == "L1.TEXT.REFERENCE_UNRESOLVED" for f in result.findings)
    result = run(make_line(1), make_line(2, short_text="wie vor", section_id="other"))
    assert any(f.rule_id == "L1.TEXT.REFERENCE_UNRESOLVED" for f in result.findings)


@pytest.mark.parametrize("item,spec", [("Rohr", "DN100"), ("Kabel", "5x2,5 mm²"),
    ("Ortbeton", "C25/30"), ("Zementestrich", "d=60 mm"), ("Dämmung", "Dicke: 8 cm"), ("Tür", "90 x 210 cm")])
def test_missing_attributes(item, spec):
    assert selected("SPEC_ATTRIBUTE_MISSING", item)
    assert selected("SPEC_ATTRIBUTE_MISSING", item, spec) == []
    result = run(make_line(1, short_text=item, long_text=spec), make_line(2, short_text=f"{item} wie vor"))
    assert not any(f.rule_id == "L1.TEXT.SPEC_ATTRIBUTE_MISSING" for f in result.findings)


def test_attribute_excludes_removal_and_unrelated_mentions():
    assert selected("SPEC_ATTRIBUTE_MISSING", "Tür ausbauen") == []
    assert selected("SPEC_ATTRIBUTE_MISSING", "Halter", "Kabel und Rohr") == []
    assert selected("SPEC_ATTRIBUTE_MISSING", "Boden Graben Kabel") == []
    assert selected("SPEC_ATTRIBUTE_MISSING", "Anschluss SW-Leitung DN100") == []
    assert selected("SPEC_ATTRIBUTE_MISSING", "Rohr markieren") == []
    assert selected("SPEC_ATTRIBUTE_MISSING", "Rohr Stahl", "Außendurchmesser 273 mm") == []


def test_person_redactions_and_internal_component_references():
    assert selected("SPEC_PLACEHOLDER", "Kontakt [PERSON_123] in [ORT_30]") == []
    assert selected("REFERENCE_UNRESOLVED", "Belüftungsanlage", "Mit Untergestell und Luftverteilsystem wie vor beschrieben") == []
    assert selected("SPEC_PLACEHOLDER", "Hydrant", "Fabrikat Erhard oder gleichwertig Fabrikat:........") == []
