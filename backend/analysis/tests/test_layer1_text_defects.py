import pytest

from analysis.adapter import from_file
from analysis.runner import analyze
from test_layer1 import DATA, make_line, run


def selected(rule, short, long="", phase="83"):
    result = run(make_line(short_text=short, long_text=long), phase=phase)
    assert not result.errors
    return [f for f in result.findings if f.rule_id == f"L1.TEXT.{rule}"]


@pytest.mark.parametrize("text", ["Fabrikat [FIRMA_095]", "[KENNZEICHEN_005]", "Widerstandsklasse: ---", "Fabrikat: ……", "Typ XXX"])
def test_placeholders(text):
    finding, = selected("SPEC_PLACEHOLDER", text)
    assert finding.evidence["kind"] == "placeholder"
    assert finding.evidence["bieterfrage_de"].startswith("Zu Pos. 01.0001:")


@pytest.mark.parametrize("text", [
    "Fabrikat z. B. [FIRMA_095]",
    "Lieferant/Hersteller: [FIRMA_095] oder\ngleichwertig",
    "Hersteller: [FIRMA_095] & Co. KG",
    "Hersteller: [FIRMA_095]\n49090 Osnabrück",
])
def test_supplier_redactions_in_examples_and_contact_details(text):
    assert selected("SPEC_PLACEHOLDER", "Pumpe DN 150", text) == []


@pytest.mark.parametrize("filename", [
    "8209.003_Leistungsverzeichnis_leer.X83",
    "8209.003_Leistungsverzeichnis_leer.D83",
    "GAEB-[PROJEKT_004].X83",
    "[ORT_024] LV24069.D86",
])
def test_reviewed_supplier_redactions_are_clean_in_original_tenders(filename):
    result = analyze(from_file(DATA / filename), [1])
    assert result.errors == []
    assert not any(finding.rule_id == "L1.TEXT.SPEC_PLACEHOLDER" for finding in result.findings)


def test_supplier_context_does_not_hide_unresolved_technical_fields():
    long = "Hersteller: [FIRMA_095] & Co. KG. Typ: [TYP_123]"
    finding, = selected("SPEC_PLACEHOLDER", "Pumpe", long)
    assert len(finding.evidence["excerpts"]) == 1
    assert "[TYP_123]" in finding.evidence["excerpts"][0]
    assert selected("SPEC_PLACEHOLDER", "Pumpe", "Hersteller: [FIRMA_095]")


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

def test_concrete_compares_the_same_component_when_global_grade_sets_overlap():
    short = "Fundament C20/25. Rückenstütze C25/30."
    detail = "Fundament aus Beton C25/30. Rückenstütze aus Beton C25/30."
    finding, = selected("VALUE_CONFLICT", short, detail)
    assert finding.severity == "warning"
    assert finding.evidence["component"] == "fundament"
    assert finding.evidence["short_quote"] == "Fundament C20/25"
    assert finding.evidence["long_quote"] == "Fundament aus Beton C25/30"
    assert not finding.suggested_fix.operations
    assert "Fundament" in finding.suggested_fix.rationale


def test_concrete_separate_components_and_equivalent_alternatives_stay_clear():
    short = "Fundament aus Beton C20/25."
    assert not selected("VALUE_CONFLICT", short, "Rückenstütze aus Beton C25/30.")
    assert not selected("VALUE_CONFLICT", short, "Fundament C25/30 (LP) oder C20/25.")
    assert not selected("VALUE_CONFLICT", short, "C 20 / 25 für das Fundament.")


def test_concrete_foundation_and_bedding_ask_about_scope_before_selecting_grade():
    short = "Betonbord mit Fundament Rückenstütze C20/25."
    detail = "Bettung: 20 cm Normalbeton C25/30 (LP). Rückenkeil: 10 cm."
    finding, = selected("VALUE_CONFLICT", short, detail)
    assert finding.severity == "info"
    assert finding.evidence["short_components"] == ["fundament"]
    assert finding.evidence["long_components"] == ["bettung"]
    assert finding.evidence["short_quote"] == "Fundament Rückenstütze C20/25"
    assert finding.evidence["long_quote"] == "Bettung: 20 cm Normalbeton C25/30"
    assert "dasselbe Bauteil" in finding.evidence["bieterfrage_de"]
    assert not finding.suggested_fix.operations


def test_concrete_single_shared_grade_specification_can_cover_two_components():
    short = "Fundament und Rückenstütze C20/25."
    detail = "C25/30 für das Fundament. Rückenstütze C20/25."
    finding, = selected("VALUE_CONFLICT", short, detail)
    assert finding.evidence["component"] == "fundament"
    assert finding.evidence["long_quote"] == "C25/30 für das Fundament"

def test_concrete_relational_phrase_keeps_uncertain_attribution():
    finding, = selected(
        "VALUE_CONFLICT", "Fundament unter der Bodenplatte aus Beton C20/25.",
        "Rückenstütze aus Beton C25/30.",
    )
    assert "component" not in finding.evidence
    assert finding.evidence["short_quote"] == "C20/25"



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


def test_values_in_included_clauses_are_not_conflicts():
    short = "Bodenplatte aus Stahlbeton C30/37, d = 30 cm"
    long = "Bodenplatte herstellen. Einschließlich Sauberkeitsschicht aus Beton C8/10, d = 10 cm."
    assert not selected("VALUE_CONFLICT", short, long)
    assert selected("VALUE_CONFLICT", short, "Bodenplatte herstellen, d = 25 cm.")



@pytest.mark.parametrize(("short", "detail", "left", "right"), [
    ("Bauzaun H = 2,0 m", "Mobilen Bauzaun, Höhe 1,20 m, mit Fußplatten liefern.", "H = 2,0 m", "Höhe 1,20 m"),
    ("Geländer, Höhe: 1100 mm", "Geländer H = 100 cm montieren.", "Höhe: 1100 mm", "H = 100 cm"),
])
def test_height_conflict_requires_the_same_named_component(short, detail, left, right):
    finding, = selected("VALUE_CONFLICT", short, detail)
    assert finding.evidence["family"] == "height"
    assert (finding.evidence["short_quote"], finding.evidence["long_quote"]) == (left, right)
    assert finding.suggested_fix.rationale and finding.evidence["bieterfrage_de"]
    assert finding.severity == "warning"


@pytest.mark.parametrize("detail", [
    "Mobilen Bauzaun, Höhe 200 cm, mit Fußplatten liefern.",
    "Bauzaun mit Pfosten, Höhe 1,20 m für die Pfosten.",
    "Pfosten für Bauzaun, Höhe 1,20 m.",
    "Bauzaun, Pfosten Höhe: 1,20 m.",
    "Geländer Höhe 1,20 m auf der Baustelle montieren.",
    "Bauzaun, Höhe 1,20 m oder 2,00 m.",
    "Bauzaun, Höhe 1,20 m oder Höhe 2,00 m.",
    "Bauzaun, Höhe 1,20 m bis 2,00 m.",
    "Bauzaun, Höhe 1,20 m – 2,00 m.",
    "Bauzaun, Höhe 1,20 m und 2,00 m.",
    "Bauzaun, Höhe mindestens 1,20 m.",
    "Bauzaun, Höhe 1,20 m in Abschnitt A.",
    "Bauzaun, Höhe 1,20 m. Für Abschnitt B Höhe 2,00 m.",
    "Bauzaun, Höhe 1,20 m².",
])
def test_height_check_preserves_different_components_and_uncertain_requirements(detail):
    assert not any(f.evidence.get("family") == "height"
                   for f in selected("VALUE_CONFLICT", "Bauzaun H = 2,0 m", detail))


def test_height_check_on_a_planted_conflict_in_the_repository_tender():
    from lxml import etree
    from analysis.adapter import from_bytes
    from tender_import.common import parse_xml

    path = DATA / "501-24-01_GAEB-XML_sas.x83"
    content = path.read_bytes()
    original = from_bytes(path.name, content)
    position = next(line for line in original.lines if line.code == "01.01.0005")
    root = parse_xml(content)
    item = root.find(position.source_locator["xml_path"])
    description = next(node for node in item.iter() if etree.QName(node).localname == "DetailTxt")
    fragment = next(node for node in description.iter() if node.text and "Bauzaun H = 2,0 m" in node.text)
    fragment.text = fragment.text.replace("Bauzaun H = 2,0 m", "Bauzaun H = 1,20 m", 1)
    mutated = from_bytes(path.name, etree.tostring(root))

    def comparable(snapshot):
        return [(line.code, line.short_text, line.long_text, line.quantity, line.unit) for line in snapshot.lines]

    before, after = comparable(original), comparable(mutated)
    assert len(before) == len(after)
    assert [a[0] for a, b in zip(before, after) if a != b] == [position.code]

    def height_findings(snapshot):
        result = analyze(snapshot, [1])
        assert not result.errors
        return [f for f in result.findings if f.rule_id == "L1.TEXT.VALUE_CONFLICT" and f.evidence["family"] == "height"]

    assert height_findings(original) == []
    finding, = height_findings(mutated)
    assert finding.target.line_code == position.code
    assert finding.source_locator["source_id"] == position.source_locator["source_id"]
    assert finding.evidence["long_quote"] == "H = 1,20 m"


def test_board_thickness_conflict_preserves_the_original_quotes():
    short = "GK-Ständerwand 12,5 mm beplankt"
    detail = "Metallständerwand CW 75, beidseitig einlagig beplankt mit Gipsplatten Typ A, d = 15 mm, Fugen gespachtelt."
    finding, = selected("VALUE_CONFLICT", short, detail)
    assert finding.evidence["family"] == "board_thickness"
    assert finding.evidence["short_quote"] == "12,5 mm beplankt"
    assert finding.evidence["long_quote"] == "d = 15 mm"
    assert finding.suggested_fix.rationale


@pytest.mark.parametrize("detail", [
    "Metallständerwand beplankt mit Gipsplatten Typ A, Dicke 1,25 cm.",
    "Metallständerwand mit Untergrund, Dicke 15 mm.",
    "Metallständerwand beplankt mit Gipsplatten Typ A, d = 15 mm oder d = 12,5 mm.",
    "Metallständerwand zweilagig beplankt mit Gipsplatten Typ A, d = 25 mm gesamt.",
    "Metallständerwand nicht beplankt mit Gipsplatten Typ A, d = 15 mm.",
    "Metallständerwand beplankt mit Gipsplatten Typ A, d = 15 mm. Gegenseite mit Gipsplatten, d = 12,5 mm.",
])
def test_board_thickness_check_skips_equivalence_other_components_and_composites(detail):
    assert not any(f.evidence.get("family") == "board_thickness"
                   for f in selected("VALUE_CONFLICT", "GK-Ständerwand 12,5 mm beplankt", detail))
