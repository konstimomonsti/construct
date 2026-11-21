"""Bidder question templates: deterministic German text keyed by rule id."""

import re

from analysis import questions as q
from analysis.contracts import AnalysisInput, Finding, Line, Project, Section, Status, Target
from analysis.layer2.schema import load_rules


def make_input(phase="83", codes=("01.0010", "01.0020", "01.0030")) -> AnalysisInput:
    sections = [Section(id="s1", code="01", title="Estrich", sort_order=0),
                Section(id="s2", code="02", title="Maler", sort_order=10)]
    lines = [Line(id=f"l{i}", code=code, section_id="s1" if i < 2 else "s2", sort_order=i + 1,
                  short_text=f"Position {code}", quantity=None, unit_raw="m2")
             for i, code in enumerate(codes)]
    return AnalysisInput(project=Project(gaeb_phase=phase), sections=sections, lines=lines)


def finding(rule_id, line_id="l0", severity="error", status="open", layer=1, evidence=None, **fields):
    return Finding.create(rule_id=rule_id, layer=layer, target=Target(line_id=line_id), severity=severity,
                          status=status, scope="line", category="test", title="t", message="m",
                          evidence=evidence or {}, **fields)


def texts(inp, findings):
    return [question.text for question in q.build_questions(inp, findings)]


def test_missing_quantity_uses_the_plan_wording():
    [text] = texts(make_input(), [finding("L1.QTY.MISSING")])
    assert text == ("Pos. 01.0010 „Position 01.0010“: Für diese Position ist keine Menge angegeben. Bitte teilen "
                    "Sie uns die anzubietende Menge mit bzw. bestätigen Sie, ob die Leistung pauschal anzubieten ist.")


def test_same_rule_in_one_section_becomes_one_question_that_lists_the_oz():
    result = q.build_questions(make_input(), [finding("L1.QTY.MISSING", "l0"), finding("L1.QTY.MISSING", "l1"),
                                              finding("L1.QTY.MISSING", "l2")])
    assert len(result) == 2  # section 01 holds two positions, section 02 one
    assert "Positionen 01.0010, 01.0020" in result[0].text and result[0].refs == ["01.0010", "01.0020"]
    assert result[0].section == "01 Estrich" and result[1].section == "02 Maler"
    assert len(result[0].finding_ids) == 2


def test_long_oz_lists_are_shortened():
    codes = [f"01.{n:04d}" for n in range(30)]
    inp = make_input(codes=codes)
    for line in inp.lines:
        line.section_id = "s1"
    [question] = q.build_questions(inp, [finding("L1.QTY.MISSING", f"l{n}") for n in range(30)])
    assert "und 18 weitere" in question.text and "(30 Positionen)" in question.text


def test_duplicate_names_the_other_position():
    [text] = texts(make_input(), [finding("L1.DUP.SUSPECTED", "l1", evidence={"same_as": "01.0010"})])
    assert text.startswith("Pos. 01.0020 und Pos. 01.0010 beschreiben dem Anschein nach dieselbe Leistung")


def test_provisional_item_question():
    [text] = texts(make_input(), [finding("L1.STRUCT.PROVISIONAL_ITEM", severity="info")])
    assert "Pos. 01.0010 ist als Bedarfsposition gekennzeichnet" in text


def test_layer2_gap_uses_german_dependency_name_and_trigger_codes():
    f = finding("L2.FLOOR.SCREED_NEEDS_EDGE_INSULATION", layer=2, severity="warning",
                evidence={"reason": "missing", "dependency": "Edge insulation",
                          "trigger_items": [{"code": "01.0010"}, {"code": "01.0020"}]})
    [text] = texts(make_input(), [f])
    assert text.startswith("Zu Pos. 01.0010, 01.0020 ist keine Position für Randdämmstreifen enthalten.")
    assert "bauseits erbracht wird oder zusätzlich anzubieten ist" in text


def test_layer2_quantity_shortfall_names_both_quantities():
    f = finding("L2.SANITARY.WC_NEEDS_WC_SEAT", layer=2, severity="warning",
                evidence={"reason": "quantity_shortfall", "quantity_unit": "St", "trigger_quantity": "12",
                          "dependency_quantity": "10", "trigger_items": [{"code": "01.0010"}]})
    [text] = texts(make_input(), [f])
    assert "WC-Sitze nur mit 10 St enthalten, bei 12 St" in text


def test_layer2_not_assessable_is_not_a_question():
    f = finding("L2.FLOOR.SCREED_NEEDS_SKIRTING", layer=2, severity="info",
                evidence={"reason": "quantity_not_assessable"})
    assert texts(make_input(), [f]) == []


def test_price_arithmetic_and_bidder_input_rules_have_no_question():
    rules = ["L1.PRICE.ZERO", "L1.ARITH.LINE_AMOUNT", "L1.ARITH.SECTION_TOTAL", "L1.TEXT.BIDDER_INPUT",
             "L1.IMPORT.WARNING", "L1.PRICE.OUTLIER"]
    assert texts(make_input(), [finding(r) for r in rules]) == []


def test_dismissed_findings_are_left_out_and_accepted_ones_stay():
    findings = [finding("L1.QTY.MISSING", "l0", status=Status.REJECTED.value),
                finding("L1.QTY.ZERO", "l1", status=Status.ACCEPTED.value)]
    [text] = texts(make_input(), findings)
    assert "Menge ist mit 0 angegeben" in text


def test_only_tenders_get_questions():
    for phase in ("84", "86"):
        assert q.build_questions(make_input(phase), [finding("L1.QTY.MISSING")]) == []
    assert len(q.build_questions(make_input(None), [finding("L1.QTY.MISSING")])) == 1


def test_output_is_deterministic_and_in_document_order():
    findings = [finding("L1.QTY.MISSING", "l2"), finding("L1.UNIT.MISSING", "l0"), finding("L1.QTY.ZERO", "l1")]
    first = [x.to_dict() for x in q.build_questions(make_input(), findings)]
    second = [x.to_dict() for x in q.build_questions(make_input(), list(reversed(findings)))]
    assert first == second
    assert [x["refs"][0] for x in first] == ["01.0010", "01.0020", "01.0030"]
    assert len({x["id"] for x in first}) == 3


def test_every_template_renders_without_gaps():
    """No placeholder may be left unfilled, for one finding and for a group."""
    for rule_id, (single, plural) in q.TEMPLATES.items():
        for findings in ([finding(rule_id, "l0", evidence={"same_as": "01.0020"})],
                         [finding(rule_id, "l0"), finding(rule_id, "l1")]):
            [question] = q.build_questions(make_input(), findings)
            assert "?" not in question.text.replace("Pos. ?", ""), (rule_id, question.text)
            assert not re.search(r"[{}]", question.text), (rule_id, question.text)


def test_every_layer2_dependency_has_a_german_name():
    missing = [f"{rule.rule_id}_NEEDS_{dep.key}" for rule in load_rules() for dep in rule.dependencies
               if dep.key not in q.DEPENDENCY_DE]
    assert not missing, f"add German names to DEPENDENCY_DE: {missing}"
