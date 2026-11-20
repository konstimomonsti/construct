from collections import Counter
from decimal import Decimal
from pathlib import Path

import pytest

from analysis import adapter, units
from analysis.contracts import AnalysisInput, Finding, Line, SetField, Target, finding_key
from analysis.registry import _REGISTRY, rule, run_layer
from analysis.runner import analyze

DATA = Path(__file__).resolve().parents[2] / "Data"
GAEB_FILES = sorted(p for p in DATA.glob("*") if p.suffix.lower()[:2] in {".x", ".d"} and p.suffix[2:].isdigit())


def parse_raw(path):
    from tender_import.common import detect_format
    from tender_import.legacy import gaeb_1990
    from tender_import.structured import gaeb_xml
    data = path.read_bytes()
    return gaeb_xml(data) if detect_format(path.name, data) == "gaeb_xml" else gaeb_1990(data)


# ---------------------------------------------------------------- units


@pytest.mark.parametrize("raw, expected", [
    ("St", "ea"), ("Stk.", "ea"), ("m2", "m²"), ("m²", "m²"), ("m3", "m³"), ("psch", "lump_sum"),
    ("Std.", "h"), ("to", "t"), ("Wo", "week"), ("StWo", "ea·week"), ("Jahr", "year"), (" m ", "m"),
    ("Fass", "Fass"), ("", None), (None, None),
])
def test_unit_normalize(raw, expected):
    assert units.normalize(raw) == expected


def test_unit_dimension():
    assert units.dimension("m²") is units.Dimension.AREA
    assert units.dimension("Fass") is units.Dimension.UNKNOWN
    assert not units.is_known("Fass")


# ---------------------------------------------------------------- flags


@pytest.mark.parametrize("flags, expected", [
    ({}, ("unit_rate", "include")),
    ({"LumpSumItem": "Yes"}, ("lump_sum", "include")),
    ({"Provis": "WithoutTotal"}, ("unit_rate", "unit_price_only")),
    ({"Provis": "WithTotal"}, ("unit_rate", "conditional")),
    ({"position_type": "A", "provisional_flag": "N", "extra_type_flag": "N"}, ("unit_rate", "conditional")),
    ({"position_type": "N", "provisional_flag": "E", "extra_type_flag": "L"}, ("lump_sum", "unit_price_only")),
])
def test_derive_pricing(flags, expected):
    assert adapter.derive_pricing(flags) == expected


# ---------------------------------------------------------------- real GAEB files


@pytest.mark.parametrize("path", GAEB_FILES, ids=lambda p: p.name)
def test_from_file_keeps_every_item(path):
    raw = parse_raw(path)
    analysis_input = adapter.from_file(path)
    assert len(analysis_input.lines) == sum(r.kind == "item" for r in raw.records)
    assert len({line.id for line in analysis_input.lines}) == len(analysis_input.lines)
    assert analysis_input.input_hash == analysis_input.compute_hash()
    section_ids = {s.id for s in analysis_input.sections}
    if section_ids:
        assert all(line.section_id in section_ids for line in analysis_input.lines if line.section_id)
        assert all(s.parent_id in section_ids for s in analysis_input.sections if s.parent_id)


@pytest.mark.parametrize("path", GAEB_FILES, ids=lambda p: p.name)
def test_hash_is_stable_and_json_round_trips(path, tmp_path):
    first = adapter.from_file(path)
    assert adapter.from_file(path).input_hash == first.input_hash
    adapter.to_json(first, tmp_path / "input.json")
    assert adapter.from_json(tmp_path / "input.json").input_hash == first.input_hash


def test_xml_and_gaeb90_copies_agree():
    xml = adapter.from_file(DATA / "8209.003_Leistungsverzeichnis_leer.X83")
    d83 = adapter.from_file(DATA / "8209.003_Leistungsverzeichnis_leer.D83")
    assert [(l.code, l.quantity, l.unit) for l in xml.lines] == [(l.code, l.quantity, l.unit) for l in d83.lines]
    assert Counter(l.pricing_basis for l in xml.lines)["lump_sum"] == 14


def test_bid_amounts_and_subtotals():
    bid = adapter.from_file(DATA / "Angebot AN24-0305.D84")
    first = bid.lines[0]
    assert first.source_amounts.unit_price == Decimal("72000.000")
    assert first.source_amounts.line_amount == Decimal("72000.00")
    assert bid.bom.stated_net_total == Decimal("988913.89")

    award = adapter.from_file(DATA / "StBALV23040.D86")
    totals = {s.code: s.stated_total for s in award.sections}
    assert totals["01.01"] == Decimal("115032.36")
    assert award.project.currency == "EUR"


def test_xml_currency_alias():
    assert adapter.from_file(DATA / "[NUMMER_001]_leer.X83").project.currency == "EUR"


# ---------------------------------------------------------------- contract, registry, runner


def test_set_field_rejects_unknown_field():
    with pytest.raises(ValueError):
        SetField(line_id="x", field="price.unit")


def test_finding_key_is_stable():
    target = Target(line_id="a", field="quantity")
    assert finding_key("L1.X", target) == finding_key("L1.X", Target(line_id="a", field="quantity"))
    assert finding_key("L1.X", target) != finding_key("L1.Y", target)


def test_registry_builds_findings_and_isolates_crashes():
    @rule("L1.TEST.NO_QTY", layer=1, category="completeness", severity="error", title="No qty", description="test")
    def no_qty(ctx):
        for line in ctx.input.lines:
            if line.quantity is None:
                yield ctx.finding(line=line, field="quantity", message="missing", evidence={"q": Decimal("1.5")})

    @rule("L1.TEST.CRASH", layer=1, category="completeness", severity="error", title="Crash", description="test")
    def crash(ctx):
        raise RuntimeError("boom")

    try:
        analysis_input = AnalysisInput(lines=[Line(id="a", sort_order=1, code="01.0010"), Line(id="b", sort_order=2,
                                                                                            quantity=Decimal(2))])
        errors = []
        findings = [f for f in run_layer(1, analysis_input, [], errors) if f.rule_id.startswith("L1.TEST.")]
        assert [f.target.line_id for f in findings] == ["a"]
        assert findings[0].scope == "line" and findings[0].evidence == {"q": "1.5"}
        assert errors and "L1.TEST.CRASH" in errors[0]

        result = analyze(analysis_input, layers=[1, 2])
        assert result.layers_run == [1, 2]
        assert not any("layer 2" in e for e in result.errors)
        assert result.summary.by_rule["L1.TEST.NO_QTY"] == 1
        assert isinstance(result.findings[0], Finding)
    finally:
        _REGISTRY.pop("L1.TEST.NO_QTY", None)
        _REGISTRY.pop("L1.TEST.CRASH", None)
