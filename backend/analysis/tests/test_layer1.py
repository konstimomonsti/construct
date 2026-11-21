from datetime import date
from decimal import Decimal as D
from pathlib import Path

import pytest

from analysis import adapter
from analysis import layer1  # noqa: F401  registers the rules
from analysis.contracts import (
    AnalysisInput, Bom, Distribution, ImportWarning, Line, PriceInfo, Project, ReferenceRange, Section, SourceAmounts,
)
from analysis.registry import rules_for
from analysis.runner import analyze

DATA = Path(__file__).resolve().parents[3] / "data" / "tenders"
SECTION = Section(id="s1", code="01", code_parts=["01"], title="Erdarbeiten", sort_order=0)


def make_line(number=1, **fields):
    defaults = dict(id=f"l{number}", code=f"01.{number:04d}", code_parts=["01", f"{number:04d}"], section_id="s1",
                    sort_order=number, short_text=f"Position {number}", long_text=f"Langtext {number}",
                    quantity=D("10"), unit="m²", unit_raw="m2")
    return Line(**{**defaults, **fields})


def run(*lines, phase="83", sections=(SECTION,), **input_fields):
    analysis_input = AnalysisInput(project=Project(gaeb_phase=phase, currency="EUR"), sections=list(sections),
                                   lines=list(lines), **input_fields)
    return analyze(analysis_input, [1])


def rules(result):
    return {f.rule_id for f in result.findings}


def only(result, rule_id):
    found = [f for f in result.findings if f.rule_id == rule_id]
    assert found, f"{rule_id} not raised; got {rules(result)}"
    return found


def test_clean_input_has_no_findings():
    result = run(make_line(1), make_line(2, unit="ea", unit_raw="St", quantity=D(3)),
                 make_line(3, unit="lump_sum", unit_raw="psch", quantity=D(1)))
    assert result.findings == []
    assert result.errors == []


def test_every_rule_has_unique_l1_id():
    ids = [info.rule_id for info in rules_for(1)]
    assert len(ids) == len(set(ids)) and all(i.startswith("L1.") for i in ids)


# ---------------------------------------------------------------- completeness


def test_quantity_missing_negative_zero():
    result = run(make_line(1, quantity=None, quantity_raw="abc"), make_line(2, quantity=D(-2)),
                 make_line(3, quantity=D(0)),
                 make_line(4, quantity=D(0), source_amounts=SourceAmounts(unit_price=D(50), line_amount=D(0))),
                 make_line(5, quantity=None, unit="lump_sum", unit_raw="psch"))
    assert only(result, "L1.QTY.MISSING")[0].target.line_id == "l1"
    assert only(result, "L1.QTY.NEGATIVE")[0].target.line_id == "l2"
    zero = {f.target.line_id: f.severity for f in only(result, "L1.QTY.ZERO")}
    assert zero == {"l3": "warning", "l4": "error"}
    quantity_rules = {"L1.QTY.MISSING", "L1.QTY.NEGATIVE", "L1.QTY.ZERO"}
    for finding in result.findings:
        if finding.rule_id in quantity_rules:
            assert finding.suggested_fix.rationale
            assert finding.suggested_fix.operations == []


def test_fractional_count():
    result = run(make_line(1, unit="ea", unit_raw="St", quantity=D("2.5")), make_line(2, unit="ea", quantity=D("2.000")))
    finding, = only(result, "L1.QTY.FRACTIONAL_COUNT")
    assert finding.target.line_id == "l1"
    assert "whole count" in finding.suggested_fix.rationale
    assert finding.suggested_fix.operations == []


def test_unit_missing_and_unknown():
    result = run(make_line(1, unit=None, unit_raw=None), make_line(2, unit="Fass", unit_raw="Fass"),
                 make_line(3, unit=None, unit_raw=None, pricing_basis="lump_sum", quantity=D(1)))
    missing = {f.target.line_id: f for f in only(result, "L1.UNIT.MISSING")}
    assert "confirmed billing unit" in missing["l1"].suggested_fix.rationale
    assert missing["l1"].suggested_fix.operations == []
    assert missing["l3"].suggested_fix.operations[0].new_value == "lump_sum"
    unknown, = only(result, "L1.UNIT.UNKNOWN")
    assert unknown.target.line_id == "l2"
    assert "conversion" in unknown.suggested_fix.rationale
    assert unknown.suggested_fix.operations == []


def test_text_missing_per_line_in_tender_once_in_bid():
    tender = run(make_line(1, short_text=None, long_text=None))
    assert only(tender, "L1.TEXT.MISSING")[0].scope == "line"
    bid = run(make_line(1, short_text=None, long_text=None), make_line(2, short_text=None, long_text=None), phase="84")
    findings = only(bid, "L1.TEXT.MISSING")
    assert len(findings) == 1 and findings[0].scope == "bom" and findings[0].severity == "info"


def test_quantity_and_unit_missing_once_in_bid():
    lines = [make_line(n, quantity=None, quantity_raw=None, unit=None, unit_raw=None) for n in (1, 2, 3)]
    bid = run(*lines, phase="84")
    for rule_id in ("L1.QTY.MISSING", "L1.UNIT.MISSING"):
        findings = only(bid, rule_id)
        assert len(findings) == 1 and findings[0].scope == "bom" and findings[0].severity == "info"
        assert len(findings[0].related_line_ids) == 3
    tender = run(*lines)
    assert len(only(tender, "L1.QTY.MISSING")) == 3 and len(only(tender, "L1.UNIT.MISSING")) == 3


def test_markup_item_needs_no_quantity_or_unit_and_counts_in_total():
    markup = make_line(2, quantity=None, quantity_raw=None, unit=None, unit_raw=None, pricing_basis="lump_sum",
                       gaeb_flags={"MarkupItem": "Yes", "Markup": "10.00", "ITMarkup": "100.00"},
                       source_amounts=SourceAmounts(unit_price=None, line_amount=D("10.00")))
    priced = make_line(1, source_amounts=SourceAmounts(unit_price=D(10), line_amount=D(100)))
    result = run(priced, markup, bom=Bom(stated_net_total=D("110.00")))
    assert rules(result) == set()


def test_code_missing_and_duplicate():
    result = run(make_line(1, code=None, code_parts=["TE", "L0"]), make_line(2, code="01.0003"), make_line(3))
    assert only(result, "L1.CODE.MISSING")[0].target.line_id == "l1"
    duplicate = only(result, "L1.CODE.DUPLICATE")
    assert [f.target.line_id for f in duplicate] == ["l3"] and duplicate[0].related_line_ids == ["l2"]
    assert duplicate[0].suggested_fix.operations == []
    assert "confirmed duplicate" in duplicate[0].suggested_fix.rationale


# ---------------------------------------------------------------- consistency


def test_unit_text_mismatch_explicit_statement_only():
    result = run(make_line(1, unit="ea", unit_raw="St", long_text="Pflaster verlegen. Abrechnung nach m2."),
                 make_line(2, unit="h", long_text="Pumpenbetrieb. Abrechnung nach Stück x Stunden."),
                 make_line(3, unit="m²", long_text="Abrechnungseinheit: m2"))
    finding = only(result, "L1.UNIT.TEXT_MISMATCH")
    assert [f.target.line_id for f in finding] == ["l1"]
    assert finding[0].suggested_fix.operations[0].new_value == "m²"


def test_lump_sum_rules_and_no_noise_for_plain_psch():
    result = run(make_line(1, unit="lump_sum", unit_raw="psch", quantity=D(3)),
                 make_line(2, unit="m", pricing_basis="lump_sum", quantity=D(120)),
                 make_line(3, unit="lump_sum", unit_raw="psch", quantity=D(1), pricing_basis="unit_rate"))
    findings = only(result, "L1.LUMP.INCONSISTENT")
    assert {f.target.line_id for f in findings} == {"l1", "l2"}
    assert all(f.suggested_fix.rationale and f.suggested_fix.operations == [] for f in findings)


def test_lump_sum_effort_conflict_is_grounded_in_the_pricing_clause():
    source = make_line(1, short_text="Zusatzarbeiten", long_text="Leistungen nach tatsächlichem Aufwand abrechnen.",
                       quantity=D(1), unit="lump_sum", pricing_basis="lump_sum")
    finding, = only(run(source), "L1.LUMP.OPEN_SCOPE")
    assert finding.target.field == "long_text"
    assert finding.evidence["pricing_clause"] == "Leistungen nach tatsächlichem Aufwand abrechnen"
    assert finding.evidence["bieterfrage_de"].startswith("Zu Pos. 01.0001:")
    assert "L1.LUMP.OPEN_SCOPE" not in rules(run(source.model_copy(update={"unit": "h", "pricing_basis": "unit_rate"})))
    assert "L1.LUMP.OPEN_SCOPE" not in rules(run(source.model_copy(update={
        "long_text": "Die Arbeiten werden nicht nach Aufwand abgerechnet. Abrechnung pauschal.",
    })))
    assert "L1.LUMP.OPEN_SCOPE" not in rules(run(source.model_copy(update={
        "long_text": "Der Polier plant die Mannschaft nach Aufwand. Abrechnung pauschal.",
    })))


def test_bidder_input_severity_depends_on_phase():
    text = "Fabrikat: '..............' vom Bieter einzutragen"
    assert only(run(make_line(1, long_text=text)), "L1.TEXT.BIDDER_INPUT")[0].severity == "info"
    assert only(run(make_line(1, long_text=text), phase="86"), "L1.TEXT.BIDDER_INPUT")[0].severity == "warning"
    assert "L1.TEXT.BIDDER_INPUT" not in rules(run(make_line(1, long_text="Siehe Plan ... und Detail")))


def test_or_equivalent():
    result = run(make_line(1, long_text="Schachtabdeckung Typ XY oder gleichwertig."))
    assert only(result, "L1.TEXT.OR_EQUIVALENT")


def test_structure_rules():
    sections = [SECTION, Section(id="s2", code="02", code_parts=["02"], title="Leer", sort_order=1)]
    result = run(make_line(1, code="03.0001", code_parts=["03", "0001"]), make_line(2, section_id=None),
                 make_line(3, gaeb_flags={"position_type": "A"}), make_line(4, gaeb_flags={"Provis": "WithoutTotal"},
                                                                          total_rule="unit_price_only",
                                                                          source_amounts=SourceAmounts(unit_price=D(5), line_amount=D(50))),
                 sections=sections)
    assert only(result, "L1.CODE.OUTSIDE_SECTION")[0].target.line_id == "l1"
    assert only(result, "L1.STRUCT.ORPHAN_LINE")[0].target.line_id == "l2"
    assert only(result, "L1.STRUCT.EMPTY_SECTION")[0].target.section_id == "s2"
    assert only(result, "L1.STRUCT.ORPHAN_ALTERNATIVE")[0].target.line_id == "l3"
    assert only(result, "L1.STRUCT.PROVISIONAL_ITEM")[0].target.line_id == "l4"
    assert only(result, "L1.STRUCT.UNIT_PRICE_ONLY_IN_TOTAL")[0].target.line_id == "l4"


def test_suspected_duplicate_suggests_review_without_combining_quantities():
    result = run(make_line(1, short_text="Wurzelstock entsorgen", long_text="x", quantity=D(2)),
                 make_line(2, short_text="Wurzelstock entsorgen", long_text="x", quantity=D(3)))
    finding, = only(result, "L1.DUP.SUSPECTED")
    assert finding.related_line_ids == ["l1"]
    assert finding.evidence["quantities"] == ["2", "3"]
    assert finding.suggested_fix.operations == []
    assert "approved takeoff" in finding.suggested_fix.rationale


def test_real_relative_surcharges_refer_to_distinct_base_work():
    snapshot = adapter.from_file(DATA / "501-24-01_GAEB-XML_sas.x83")
    def duplicate_at_second_surcharge(analysis_input):
        return [f for f in analyze(analysis_input, [1]).findings
                if f.rule_id == "L1.DUP.SUSPECTED" and f.target.line_code == "02.03.0007"]

    assert duplicate_at_second_surcharge(snapshot) == []
    second_base, = [line for line in snapshot.lines if line.code == "02.03.0006"]
    second_base.short_text = "Unspecified work"
    second_base.long_text = None
    finding, = duplicate_at_second_surcharge(snapshot.with_hash())
    assert finding.evidence["same_as"] == "02.03.0005"
    assert finding.suggested_fix.operations == []

def test_near_duplicate_reviews_reworded_work_but_preserves_technical_variants():
    amounts = SourceAmounts(unit_price=D(20))
    left = make_line(1, short_text="Kabel im Graben links sichern",
                     long_text="Kabel im Graben links mit einer zusätzlichen Schutzabdeckung sichern.", source_amounts=amounts)
    candidate = make_line(2, short_text="Kabel im Graben links befestigen",
                          long_text="Kabel im Graben links mit einer zusätzlichen Schutzabdeckung befestigen.",
                          source_amounts=amounts)
    finding, = only(run(left, candidate), "L1.DUP.NEAR_TEXT")
    assert finding.related_line_ids == [left.id]
    assert finding.evidence["differing_terms"] == ["befestigen", "sichern"]
    assert finding.suggested_fix.operations == []
    for old, new in (("links", "rechts"), ("Kabel", "Rohr")):
        variant = candidate.model_copy(update={
            "short_text": candidate.short_text.replace(old, new),
            "long_text": candidate.long_text.replace(old, new),
        })
        assert "L1.DUP.NEAR_TEXT" not in rules(run(left, variant))


def test_reworded_duplicate_check_keeps_real_award_variants_separate():
    result = analyze(adapter.from_file(DATA / "StBALV23040.D86"), [1])
    assert result.errors == []
    assert "L1.DUP.NEAR_TEXT" not in rules(result)


def test_distribution_sum():
    result = run(make_line(1, distributions=[Distribution(area_id="a", quantity=D(4)),
                                             Distribution(area_id="b", quantity=D(5))]))
    assert only(result, "L1.DIST.SUM_MISMATCH")[0].evidence["distributed"] == "9"


# ---------------------------------------------------------------- arithmetic


def test_line_amount_unit_price_prevails():
    result = run(make_line(1, quantity=D(1000), source_amounts=SourceAmounts(unit_price=D(15), line_amount=D(14000))),
                 make_line(2, quantity=D("2.5"), source_amounts=SourceAmounts(unit_price=D("1.005"), line_amount=D("2.51"))),
                 phase="84")
    finding = only(result, "L1.ARITH.LINE_AMOUNT")
    assert [f.target.line_id for f in finding] == ["l1"]
    assert finding[0].evidence["expected_amount"] == "15000.00"


def test_section_and_net_totals():
    amounts = dict(source_amounts=SourceAmounts(unit_price=D(10), line_amount=D(100)))
    section = SECTION.model_copy(update={"stated_total": D(300)})
    orphan = make_line(3, section_id=None, code=None, **amounts)
    result = run(make_line(1, **amounts), make_line(2, **amounts), orphan, sections=[section], phase="86",
                 bom=Bom(stated_net_total=D(0)))
    section_finding = only(result, "L1.ARITH.SECTION_TOTAL")[0]
    assert section_finding.related_line_ids == ["l3"] and section_finding.severity == "error"
    net = only(result, "L1.ARITH.NET_TOTAL")[0]
    assert net.severity == "info" and net.evidence["computed"] == "300"


def test_parent_totals_use_discounted_subsection_amounts():
    # 01 contains 01.01 (200, 10 % discount -> 180) and one direct item (100): 01 and the BoQ total 280.
    parent = Section(id="s1", code="01", code_parts=["01"], sort_order=0, stated_total=D(280))
    child = Section(id="s2", parent_id="s1", code="01.01", code_parts=["01", "01"], sort_order=1,
                    stated_total=D(200), stated_total_after_discount=D(180))
    amounts = dict(source_amounts=SourceAmounts(unit_price=D(10), line_amount=D(100)))
    lines = [make_line(n, code=f"01.01.{n:04d}", code_parts=["01", "01", f"{n:04d}"], section_id="s2", **amounts)
             for n in (1, 2)] + [make_line(3, **amounts)]
    result = run(*lines, sections=[parent, child], phase="84", bom=Bom(stated_net_total=D(280)))
    assert not {"L1.ARITH.SECTION_TOTAL", "L1.ARITH.NET_TOTAL"} & rules(result)
    wrong = run(*lines, sections=[parent.model_copy(update={"stated_total": D(300)}), child], phase="84")
    finding = only(wrong, "L1.ARITH.SECTION_TOTAL")[0]
    assert finding.evidence["computed"] == "280" and finding.evidence["discounted_subsections"] == ["01.01"]
    lump = child.model_copy(update={"stated_total_after_discount": None, "stated_lump_sum_total": D(150)})
    result = run(*lines, sections=[parent.model_copy(update={"stated_total": D(250)}), lump], phase="84",
                 bom=Bom(stated_net_total=D(250)))
    assert not {"L1.ARITH.SECTION_TOTAL", "L1.ARITH.NET_TOTAL"} & rules(result)


# ---------------------------------------------------------------- pricing


def priced(number, **price):
    return make_line(number, price=PriceInfo(**{"unit_price": D(20), "currency": "EUR", "price_unit": "m²",
                                                "source": "catalogue", "match_confidence": 0.95, **price}))


def test_pricing_rules():
    result = run(
        priced(1, unit_price=None, source="none"),
        priced(2, unit_price=D(0)),
        priced(3, price_unit="m"),
        priced(4, price_unit="cm²"),
        priced(5, currency="CHF"),
        priced(6, unit_price=D(100), reference_range=ReferenceRange(min=D(15), median=D(20), max=D(30), n=5)),
        priced(7, source="ai", match_confidence=0.7),
        priced(8, price_date=date(2015, 1, 1)),
    )
    def ids(rule_id):
        return [f.target.line_id for f in only(result, rule_id)]
    assert ids("L1.PRICE.NOT_FOUND") == ["l1"]
    assert ids("L1.PRICE.ZERO") == ["l2"]
    severities = {f.target.line_id: f.severity for f in only(result, "L1.PRICE.UNIT_MISMATCH")}
    assert severities == {"l3": "error", "l4": "warning"}
    assert ids("L1.PRICE.CURRENCY_MISMATCH") == ["l5"]
    assert ids("L1.PRICE.OUTLIER") == ["l6"]
    assert ids("L1.PRICE.LOW_CONFIDENCE") == ["l7"]
    assert ids("L1.PRICE.STALE") == ["l8"]


def test_price_missing_in_bid_and_deviation():
    result = run(make_line(1), make_line(2, source_amounts=SourceAmounts(unit_price=D(50), line_amount=D(500)),
                                         price=PriceInfo(unit_price=D(20), price_unit="m²", currency="EUR")),
                 phase="84")
    assert [f.target.line_id for f in only(result, "L1.PRICE.MISSING_IN_FILE")] == ["l1"]
    assert only(result, "L1.PRICE.SOURCE_DEVIATION")[0].evidence["deviation"] == 1.5


def test_import_warnings_surface():
    result = run(make_line(1), import_warnings=[ImportWarning(code="damaged_item_code", message="bad code")])
    assert only(result, "L1.IMPORT.WARNING")[0].scope == "bom"


# ---------------------------------------------------------------- real files


def test_real_award_with_change_orders():
    result = analyze(adapter.from_file(DATA / "[ORT_024] LV24069.D86"), [1])
    assert result.summary.by_rule["L1.UNIT.MISSING"] == 38
    assert result.summary.by_rule["L1.QTY.ZERO"] == 38
    assert result.errors == []


def test_real_award_subtotal_explained_by_damaged_code():
    result = analyze(adapter.from_file(DATA / "StBALV23040.D86"), [1])
    subtotal = [f for f in result.findings if f.rule_id == "L1.ARITH.SECTION_TOTAL" and f.evidence["difference"] == "982.20"]
    orphan = [f for f in result.findings if f.rule_id == "L1.CODE.MISSING"][0]
    assert subtotal and all(f.related_line_ids == [orphan.target.line_id] for f in subtotal)


@pytest.mark.parametrize("name", ["8209.003_Leistungsverzeichnis_leer.X83", "GAEB-[PROJEKT_004].X83"])
def test_clean_tenders_have_no_errors(name):
    result = analyze(adapter.from_file(DATA / name), [1])
    assert result.summary.by_severity.get("error", 0) == 0
    assert result.errors == []


def test_findings_are_stable_between_runs():
    path = DATA / "StBALV23040.D86"
    first = [f.id for f in analyze(adapter.from_file(path), [1]).findings]
    assert first == [f.id for f in analyze(adapter.from_file(path), [1]).findings]
