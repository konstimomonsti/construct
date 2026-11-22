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


def test_fractional_count():
    result = run(make_line(1, unit="ea", unit_raw="St", quantity=D("2.5")), make_line(2, unit="ea", quantity=D("2.000")))
    assert [f.target.line_id for f in only(result, "L1.QTY.FRACTIONAL_COUNT")] == ["l1"]


def test_unit_missing_and_unknown():
    result = run(make_line(1, unit=None, unit_raw=None), make_line(2, unit="Fass", unit_raw="Fass"),
                 make_line(3, unit=None, unit_raw=None, pricing_basis="lump_sum", quantity=D(1)))
    missing = {f.target.line_id: f for f in only(result, "L1.UNIT.MISSING")}
    assert missing["l1"].suggested_fix is None
    assert missing["l3"].suggested_fix.operations[0].new_value == "lump_sum"
    assert only(result, "L1.UNIT.UNKNOWN")[0].target.line_id == "l2"


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
        assert findings[0].related_line_ids == [] and list(findings[0].evidence.values()) == [3]
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
    assert {f.target.line_id for f in only(result, "L1.LUMP.INCONSISTENT")} == {"l1", "l2"}


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
    assert "L1.STRUCT.EMPTY_SECTION" not in rules(result)
    assert only(result, "L1.STRUCT.ORPHAN_ALTERNATIVE")[0].target.line_id == "l3"
    assert only(result, "L1.STRUCT.PROVISIONAL_ITEM")[0].target.line_id == "l4"
    assert only(result, "L1.STRUCT.UNIT_PRICE_ONLY_IN_TOTAL")[0].target.line_id == "l4"


def test_suspected_duplicate_shows_both_items_for_manual_comparison():
    result = run(make_line(1, short_text="Wurzelstock entsorgen", long_text="x", quantity=D(2)),
                 make_line(2, short_text="Wurzelstock entsorgen", long_text="x", quantity=D(3)))
    finding = only(result, "L1.DUP.SUSPECTED")[0]
    assert finding.target.line_id == "l2" and finding.related_line_ids == ["l1"]
    assert finding.evidence["quantities"] == ["2", "3"]
    assert finding.suggested_fix is None


def test_position_prefix_requires_action_when_it_points_to_another_section():
    second = Section(id="s2", code="02", code_parts=["02"], title="Empty", sort_order=1)
    result = run(make_line(1, code="02.0001", code_parts=["02", "0001"]),
                 make_line(2, code="03.0002", code_parts=["03", "0002"]), sections=[SECTION, second])
    findings = {f.target.line_id: f for f in only(result, "L1.CODE.OUTSIDE_SECTION")}
    assert findings["l1"].severity == "warning" and findings["l1"].evidence["matching_section_code"] == "02"
    assert findings["l2"].severity == "info"


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


def test_working_net_uses_signed_cents_conversions_and_firm_items():
    def rate(value, currency="EUR", price_unit=None):
        return PriceInfo(unit_price=D(value), currency=currency, price_unit=price_unit)

    result = run(
        make_line(1, quantity=D(1), price=rate("1.005")),
        make_line(2, short_text="Gutschrift", quantity=D(1), price=rate("-1.005")),
        make_line(3, quantity=D("1000"), unit="cm", price=rate("2", price_unit="m")),
        make_line(4, quantity=None, pricing_basis="lump_sum", price=rate("7.005")),
        make_line(5, total_rule="conditional", price=rate("500")),
        make_line(6, quantity=D(0), price=rate("50")),
        make_line(7, quantity=D(2), price=rate("50", "USD")),
    )
    assert result.totals == {
        "currency": "EUR", "working_net": "27.01", "complete": False, "counted_positions": 6,
        "missing_amounts": 1, "source_net": None,
    }


def test_missing_line_amount_cannot_be_treated_as_zero_in_original_net():
    result = run(make_line(quantity=D(1)), bom=Bom(stated_net_total=D("10")))
    assert "L1.ARITH.NET_TOTAL" not in rules(result)
    assert result.totals["working_net"] is None
    assert result.totals["source_net"] == "10"


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


def test_source_prices_use_the_same_billing_unit_and_currency():
    def rate(number, unit, currency="EUR"):
        return make_line(number, unit="kg", source_amounts=SourceAmounts(unit_price=D(2)),
                         price=PriceInfo(unit_price=D(500), price_unit=unit, currency=currency))

    finding, = only(run(rate(1, "t"), rate(2, "m"), rate(3, "t", "CHF")), "L1.PRICE.SOURCE_DEVIATION")
    assert finding.target.line_id == "l1"
    assert D(finding.evidence["our_price"]) == D("0.5")
    assert D(finding.evidence["difference"]) == D("1.5")


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


def test_import_issues_group_occurrences_and_preserve_locator_evidence():
    warnings = [ImportWarning(code="invalid_quantity", message=f"Bad value {page}", locator={"page": page})
                for page in range(1, 4)]
    warnings.append(ImportWarning(code="pdf_inventory_review", message="Optional inventory unavailable"))
    findings = {f.evidence["code"]: f for f in only(run(make_line(1), import_warnings=warnings), "L1.IMPORT.WARNING")}
    lost = findings["invalid_quantity"]
    assert lost.severity == "warning" and lost.evidence["occurrences"] == 3
    assert lost.evidence["locations"] == [{"page": 1}, {"page": 2}, {"page": 3}]
    assert "page 1" in lost.message
    assert findings["pdf_inventory_review"].severity == "info"


def test_findings_are_stable_between_runs():
    path = DATA / "StBALV23040.D86"
    first = [f.id for f in analyze(adapter.from_file(path), [1]).findings]
    assert first == [f.id for f in analyze(adapter.from_file(path), [1]).findings]
