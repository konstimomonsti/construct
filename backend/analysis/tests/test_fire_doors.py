from pathlib import Path

import pytest

from analysis.adapter import from_bytes, from_data
from analysis.layer1.fire_doors import RULE_ID
from analysis.runner import analyze


def assess(heading, detail, *, section_title="Türen", base=None):
    target = {"id": "door", "section_id": "doors", "code": "01.0010", "short_text": heading,
              "long_text": detail, "quantity": "1", "unit": "St", "source_locator": {"page": 3}}
    lines = [target]
    if base:
        lines.insert(0, {**target, "id": "base", "code": "01.0005", "short_text": base, "long_text": ""})
    result = analyze(from_data({"sections": [{"id": "doors", "code": "01", "title": section_title}], "lines": lines}), [1])
    assert not result.errors
    return result, [f for f in result.findings if f.rule_id == RULE_ID]


@pytest.mark.parametrize("heading,detail,quote", [
    ("Brandschutztür aus Stahl", "Lichte Öffnung 1000 × 2125 mm.", "Brandschutztür"),
    ("Feuerschutzabschluss liefern und montieren", "", "Feuerschutzabschluss"),
    ("Brandschutztür ausbauen und erneuern", "", "Brandschutztür"),
    ("Stahltür aus Stahl", "Feuerwiderstand erforderlich.", "Feuerwiderstand erforderlich"),
    ("Stahltür liefern", "Ausführung als Brandschutztür.", "Ausführung als Brandschutztür"),
    ("Brandschutztür mit Zarge T30", "Türblatt: EI₂ 30. Montage nach DIN.", "Brandschutztür"),
    ("Brandschutztür", "Feuerwiderstand: nicht T30.", "Brandschutztür"),
    ("Brandschutztür", "Verglasung gemäß Brandschutzplan B03.", "Brandschutztür"),
])
def test_missing_class_asks_for_requirement_without_guessing(heading, detail, quote):
    result, findings = assess(heading, detail)
    finding, = findings
    assert finding.source_locator == {"page": 3}
    assert finding.evidence["quote"] == quote
    assert finding.severity == "warning"
    assert finding.suggested_fix is None
    assert any(finding.id in q.finding_ids and "Feuerwiderstandsklasse" in q.text_de for q in result.questions)


@pytest.mark.parametrize("heading,detail,section,base", [
    ("T 30 RS - Stahltürelement", "Brandschutz: T 30 RS", "Türen", None),
    ("Brandschutztür", "Feuerwiderstandsklasse: EI₂ 30-C5 Sa.", "Türen", None),
    ("Brandschutztür feuerhemmend", "", "Türen", None),
    ("Brandschutztür", "T30. Sonstige Angaben gemäß Maßblatt.", "Türen", None),
    ("Brandschutztür", "gemäß Türliste TL-01.", "Türen", None),
    ("Brandschutztür gemäß Brandschutzkonzept B-01", "", "Türen", None),
    ("Brandschutztür", "", "Brandschutztüren T30", None),
    ("Brandschutztür", "wie vor, Breite 1010 mm.", "Türen", "Brandschutztür T30"),
    ("Brandschutztür", "wie vor, Breite 1010 mm.", "Türen", "T 30 RS - Stahltürelement"),
    ("Brandschutztür oder Stahltür", "", "Türen", None),
    ("Brandschutztür ausbauen", "", "Türen", None),
    ("Brandschutztür", "Vorhandene Tür ausbauen.", "Türen", None),
    ("Stahltür", "Lichte Öffnung 1000 x 2125 mm. Brandschutztür bauseits.", "Türen", None),
    ("Stahltür", "Brandschutz: ---", "Türen", None),
    ("Rauchschutztür", "", "Türen", None),
    ("Zarge für Brandschutztür", "", "Türen", None),
    ("Brandschutztür", "Feuerwiderstand: noch offen.", "Türen", None),
])
def test_stated_class_referenced_scope_and_non_rated_work(heading, detail, section, base):
    _, findings = assess(heading, detail, section_title=section, base=base)
    assert findings == []


def test_explicit_open_brandschutz_field_still_produces_a_bidder_question():
    result, findings = assess("Brandschutztür", "Brandschutzklasse: noch offen.")
    assert findings == []
    placeholder, = [finding for finding in result.findings if finding.rule_id == "L1.TEXT.SPEC_PLACEHOLDER"]
    assert any(placeholder.id in q.finding_ids for q in result.questions)


def test_repository_door_schedule_distinguishes_ordinary_and_rated_door_assemblies():
    path = Path(__file__).resolve().parents[3] / "data/tenders/LV_19_Sektionaltore_Stahltueren.pdf"
    original = from_bytes(path.name, path.read_bytes())
    doors = {line.code.rstrip("."): line for line in original.lines}
    standard = doors["1.2.20"]
    rated = doors["1.2.40"]
    assert standard.source_locator["page"] == 4
    assert rated.source_locator["page"] == 5
    assert "T 30 RS" in rated.short_text
    assert not any(f.rule_id == RULE_ID for f in analyze(original, [1]).findings)

    # Plant a silent omission at the original position and retain its source page.
    detail = "\n".join(part for part in rated.long_text.splitlines() if "T 30 RS" not in part)
    edited = rated.model_copy(update={"short_text": "Brandschutztür, 1010 x 2135 mm", "long_text": detail})
    altered = original.model_copy(update={"lines": [edited if line.id == rated.id else line for line in original.lines]})
    finding, = [f for f in analyze(altered, [1]).findings if f.rule_id == RULE_ID]
    assert finding.target.line_code == rated.code
    assert finding.source_locator["page"] == 5
