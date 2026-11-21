import pytest

from test_layer2 import input_for, line
from analysis.layer2 import run


def precast(*lines):
    return [f for f in run(input_for(*lines), []) if f.rule_id.startswith("L2.PRECAST.")]


@pytest.mark.parametrize("suffix,text", [
    ("SHOP_DRAWINGS", "Werkstatt- und Montagepläne"),
    ("TRANSPORT_AND_ASSEMBLY", "Einschl. Transport und Montage"),
    ("JOINT_SEALING", "Fugenabdichtung"),
    ("ANCHORS_AND_EMBEDDED_PARTS", "Sandwichplattenanker und Einbauteile"),
])
def test_each_dependency_present_missing_and_bundled(suffix, text):
    item = line("1", "FT-Sockel Sandwichelement", unit="ea")
    findings = precast(item)
    assert len(findings) == 4
    finding = next(f for f in findings if f.rule_id.endswith(suffix))
    assert finding.severity == "warning"
    assert finding.evidence["bieterfrage_de"].startswith("Zu Pos. 1:")
    assert not any(f.rule_id.endswith(suffix) for f in precast(item, line("2", text)))
    assert not any(f.rule_id.endswith(suffix) for f in precast({**item, "long_text": text}))


def test_no_trigger_for_unrelated_demolition_or_optional_items():
    assert precast(line("1", "Sandwichelement ausbauen")) == []
    assert precast(line("1", "Mauerwerk")) == []
    assert precast(line("1", "FT-Sockel", quantity="0")) == []
    assert precast(line("1", "Einlaufbauwerk, Fertigteil")) == []


@pytest.mark.parametrize("text", ["Messung Estrich", "Estrichfeuchte", "Belegreife Estrich"])
def test_screed_measurements_are_not_triggers(text):
    assert not any(f.rule_id.startswith("L2.FLOOR.SCREED") for f in run(input_for(line("1", text)), []))


@pytest.mark.parametrize("text", ["Dichtstoff für Plattenfugen", "Plattenfugen mit elastischem Dichtstoff schließen"])
def test_joint_sealing_wording_variants(text):
    item = line("1", "FT-Sockel Sandwichelement", unit="ea")
    assert not any(f.rule_id.endswith("JOINT_SEALING") for f in precast(item, line("2", text)))
