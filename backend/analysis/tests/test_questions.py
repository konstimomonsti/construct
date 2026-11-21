"""Ported archive/risk-report-ui question cases, adapted to the fixed v0.2 shape."""

import re
from pathlib import Path

import pytest

from analysis import adapter, questions as q
from analysis.contracts import AnalysisInput, Finding, Line, Project, Section, Target
from analysis.layer2.schema import load_rules
from analysis.runner import analyze


def make_input(phase="83", codes=("01.0010", "01.0020", "02.0010")):
    sections = [Section(id="s1", code="01", title="Estrich", sort_order=0),
                Section(id="s2", code="02", title="Maler", sort_order=10)]
    lines = [Line(id=f"l{i}", code=code, section_id="s1" if i < 2 else "s2", sort_order=i,
                  short_text=f"Position {code}", unit="m²", unit_raw="m2") for i, code in enumerate(codes)]
    return AnalysisInput(project=Project(gaeb_phase=phase), sections=sections, lines=lines)


def finding(rule_id, line_id="l0", **fields):
    return Finding.create(rule_id=rule_id, layer=fields.pop("layer", 1), target=Target(line_id=line_id),
                          severity=fields.pop("severity", "error"), scope="line", category=fields.pop("category", "test"),
                          title="t", message="m", **fields)


def test_missing_quantity_preserves_archived_german_wording():
    [item] = q.build_questions(make_input(), [finding("L1.QTY.MISSING")])
    assert item.text_de == ("Zu Pos. 01.0010: Für diese Position ist keine Menge angegeben. Bitte teilen Sie uns die "
                           "anzubietende Menge mit bzw. bestätigen Sie, ob die Leistung pauschal anzubieten ist.")
    assert set(item.model_dump()) == {"id", "topic", "text_de", "line_codes", "finding_ids", "rule_id"}


def test_identical_questions_group_within_sections_and_all_oz_are_retained():
    findings = [finding("L1.QTY.MISSING", f"l{i}") for i in range(3)]
    result = q.build_questions(make_input(), findings)
    assert len(result) == 2
    assert result[0].line_codes == ["01.0010", "01.0020"]
    assert "Positionen 01.0010, 01.0020" in result[0].text_de
    assert len(result[0].finding_ids) == 2


def test_long_oz_lists_are_shortened_without_losing_traceability():
    inp = make_input(codes=[f"01.{n:04d}" for n in range(30)])
    for item in inp.lines:
        item.section_id = "s1"
    [question] = q.build_questions(inp, [finding("L1.QTY.MISSING", f"l{i}") for i in range(30)])
    assert "und 18 weitere" in question.text_de and len(question.line_codes) == 30


def test_evidence_question_wins_and_equal_bodies_merge_across_positions():
    findings = [finding("L3.PRECAST.MISSING_SPEC", f"l{i}", layer=3,
                        evidence={"bieterfrage_de": f"Zu Pos. 01.00{10 + i * 10}: Bitte nennen Sie die Bauteilhöhe."})
                for i in range(2)]
    [question] = q.build_questions(make_input(), findings)
    assert question.text_de == "Zu Pos. 01.0010, 01.0020: Bitte nennen Sie die Bauteilhöhe."
    assert set(question.finding_ids) == {f.id for f in findings}


def test_distinct_explicit_questions_are_not_overmerged():
    findings = [finding("L3.PRECAST.MISSING_SPEC", f"l{i}", layer=3,
                        evidence={"bieterfrage_de": text})
                for i, text in enumerate(("Bitte nennen Sie die Höhe.", "Bitte nennen Sie die Breite."))]
    assert len(q.build_questions(make_input(), findings)) == 2


def test_explicit_wording_does_not_require_a_known_rule_namespace():
    [question] = q.build_questions(make_input(), [finding("CUSTOM", evidence={"bieterfrage_de": "Bitte klären Sie den Umfang."})])
    assert question.rule_id == "CUSTOM" and question.text_de.endswith("Bitte klären Sie den Umfang.")


def test_incomplete_shortfall_quantities_do_not_produce_an_invented_number():
    f = finding("L2.SANITARY.WC_NEEDS_WC_SEAT", layer=2,
                evidence={"reason": "quantity_shortfall", "trigger_quantity": "12", "dependency_quantity": None})
    assert q.build_questions(make_input(), [f]) == []


def test_duplicate_names_other_position():
    [question] = q.build_questions(make_input(), [finding("L1.DUP.SUSPECTED", "l1", evidence={"same_as": "01.0010"})])
    assert "Pos. 01.0010" in question.text_de and "Doppelung" in question.text_de


def test_layer2_missing_and_shortfall_keep_archived_names_quantities_and_trigger_refs():
    gap = finding("L2.FLOOR.SCREED_NEEDS_EDGE_INSULATION", layer=2, severity="warning",
                  evidence={"reason": "missing", "trigger_items": [{"code": "01.0010"}, {"code": "01.0020"}]})
    [question] = q.build_questions(make_input(), [gap])
    assert "Randdämmstreifen" in question.text_de
    assert question.line_codes == ["01.0010", "01.0020"]
    shortage = finding("L2.SANITARY.WC_NEEDS_WC_SEAT", layer=2, severity="warning",
                       evidence={"reason": "quantity_shortfall", "quantity_unit": "St", "trigger_quantity": "12",
                                 "dependency_quantity": "10", "trigger_items": [{"code": "01.0010"}]})
    [question] = q.build_questions(make_input(), [shortage])
    assert "WC-Sitze sind nur 10 St enthalten, bei 12 St" in question.text_de
    uncertain = gap.model_copy(update={"evidence": {"reason": "quantity_not_assessable"}})
    assert q.build_questions(make_input(), [uncertain]) == []


@pytest.mark.parametrize("rule_id", ["L1.PRICE.ZERO", "L1.PRICE.OUTLIER", "L1.ARITH.LINE_AMOUNT",
                                    "L1.ARITH.SECTION_TOTAL", "L1.TEXT.BIDDER_INPUT"])
def test_price_arithmetic_and_bidder_input_never_get_questions_even_with_explicit_wording(rule_id):
    assert q.build_questions(make_input(), [finding(rule_id, evidence={"bieterfrage_de": "Bitte fragen Sie."})]) == []


def test_decided_findings_are_excluded_and_priced_files_may_have_client_scope_questions():
    assert q.build_questions(make_input(), [finding("L1.QTY.MISSING", status="rejected"),
                                           finding("L1.QTY.ZERO", "l1", status="accepted")]) == []
    for phase in ("84", "86", None):
        assert len(q.build_questions(make_input(phase), [finding("L1.QTY.MISSING")])) == 1


def test_points_order_limit_and_stable_ids_do_not_depend_on_finding_order():
    inp = make_input()
    findings = [finding("L1.QTY.MISSING", severity="info"), finding("L1.UNIT.MISSING", "l1", severity="error")]
    first = q.build_questions(inp, findings)
    assert first[0].rule_id == "L1.UNIT.MISSING"
    assert first == q.build_questions(inp, list(reversed(findings)))
    many = [finding(f"L3.TEST.Q{i}", evidence={"bieterfrage_de": f"Bitte klären Sie Anforderung {i}."}) for i in range(30)]
    assert len(q.build_questions(inp, many, limit=100)) == 25
    assert q.build_questions(inp, many, limit=0) == []


def test_each_archived_template_renders_singular_and_plural_without_placeholders():
    for rule_id in q.TEMPLATES:
        for findings in ([finding(rule_id, evidence={"same_as": "01.0020"})],
                         [finding(rule_id, "l0"), finding(rule_id, "l1")]):
            [question] = q.build_questions(make_input(), findings)
            assert "?" not in question.text_de.replace("Pos. ?", ""), (rule_id, question.text_de)
            assert not re.search(r"[{}]", question.text_de)


def test_layer2_catalogue_retains_german_dependency_names():
    missing = [dependency.key for rule in load_rules() for dependency in rule.dependencies
               if dependency.key not in q.DEPENDENCY_DE]
    assert not missing


def test_grouped_dependency_question_has_one_position_prefix():
    findings = [finding("L2.FLOOR.SCREED_NEEDS_EDGE_INSULATION", f"l{i}", layer=2, severity="warning",
                        evidence={"reason": "missing"}) for i in range(2)]
    [question] = q.build_questions(make_input(), findings)
    assert question.text_de.startswith("Zu Pos. 01.0010, 01.0020: Es ist keine Position")
    assert question.text_de.count("Zu Pos.") == 1


def test_explicit_question_without_colon_rebuilds_one_prefix():
    [question] = q.build_questions(make_input(), [
        finding("CUSTOM", evidence={"bieterfrage_de": "Zu Pos. 01.0010 ist die Ausführung unklar."})])
    assert question.text_de == "Zu Pos. 01.0010 ist die Ausführung unklar."
    assert question.text_de.count("Zu Pos.") == 1


def test_demo_hall_and_precast_questions_never_duplicate_position_prefix():
    root = Path(__file__).resolve().parents[3]
    for source in (root / "data/demo/building_hall_planted.X83",
                   Path(__file__).parent / "fixtures/lv11_precast.json"):
        analysis_input = adapter.from_json(source) if source.suffix == ".json" else adapter.from_file(source)
        report = analyze(analysis_input, layers=(1, 2))
        assert all(item.text_de.count("Zu Pos.") <= 1 for item in report.questions)


def test_high_value_signals_generate_formal_german_questions_without_findings():
    inp = make_input()
    inp.lines[0].long_text = "Graben im Homogenbereich X1 mit Grundwasser."
    inp.lines[1].long_text = "Geräte bauseits beigestellt."
    result = q.build_questions(inp, [])
    assert any("Baugrundgutachten" in item.text_de for item in result)
    assert any("Bereitstellung" in item.text_de for item in result)
    assert all("Bitte" in item.text_de and "Sie" in item.text_de for item in result)


def test_written_quantity_conflict_asks_for_governing_value_without_rounding():
    snapshot = adapter.from_data({"lines": [
        {"id": "line", "code": "01.0010", "short_text": "Leitplanke montieren",
         "long_text": "Abrechnungsmenge: 12,3456 m.", "quantity": "12.34", "unit": "m"},
    ]})
    result = analyze(snapshot, [1, 2])
    conflict, = [f for f in result.findings if f.rule_id == "L1.QTY.WRITTEN_CONFLICT"]
    item, = result.questions
    assert item.finding_ids == [conflict.id] and item.topic == "Mengen"
    assert item.text_de.startswith("Zu Pos. 01.0010: ")
    assert "Mengenspalte sind 12,34 m" in item.text_de
    assert "„Abrechnungsmenge: 12,3456 m“ ergibt 12,3456 m" in item.text_de
    assert "Bitte bestätigen Sie die für die Kalkulation maßgebende Menge" in item.text_de
    assert not q.build_questions(snapshot, [conflict.model_copy(update={"status": "rejected"})])


def test_written_quantity_question_keeps_legacy_numeric_text_without_record_wrappers():
    snapshot = adapter.from_data({
        "project": {"source_document": {"format": "gaeb_1990"}},
        "lines": [{"id": "line", "code": "01.0010", "short_text": "Rohrleitung vorhalten",
                   "long_text": "[TA11 Positionsmenge = Produkt aus [\n30 m ] ]\n[TA12 mal [\n28 Wochen ] ].",
                   "quantity": "800", "unit": "mWo"}],
    })
    result = analyze(snapshot, [1, 2])
    item, = [question for question in result.questions if question.rule_id == "L1.QTY.WRITTEN_CONFLICT"]
    assert "800 mWo" in item.text_de and "840 mWo" in item.text_de
    assert "„Positionsmenge = Produkt aus 30 m mal 28 Wochen“" in item.text_de
    assert "TA11" not in item.text_de and "TA12" not in item.text_de


@pytest.mark.parametrize("evidence", [
    {"quantity": "12", "unit": "m", "written_quantities": [{"quantity": "7"}]},
    {"quantity": "12", "unit": "m", "written_quantities": [{"quantity": "12", "quote": "Positionsmenge: 12 m."}]},
    {"quantity": "NaN", "unit": "m", "written_quantities": [{"quantity": "7", "quote": "Positionsmenge: 7 m."}]},
    {"quantity": "12", "unit": "m", "written_quantities": 7},
])
def test_old_or_incomplete_quantity_evidence_does_not_invent_a_question(evidence):
    conflict = finding("L1.QTY.WRITTEN_CONFLICT", category="arithmetic", evidence=evidence)
    assert q.build_questions(make_input(), [conflict]) == []


def test_quantity_questions_with_different_source_values_stay_separate():
    snapshot = adapter.from_data({"lines": [
        {"id": "first", "code": "01.0010", "short_text": "Leitplanke montieren",
         "long_text": "Abrechnungsmenge: 7 m. Positionsmenge: 8 m.", "quantity": "10", "unit": "m"},
        {"id": "second", "code": "01.0020", "short_text": "Leitplanke entfernen",
         "long_text": "Abrechnungsmenge: 9 m.", "quantity": "10", "unit": "m"},
    ]})
    result = analyze(snapshot, [1, 2])
    questions = [question for question in result.questions if question.rule_id == "L1.QTY.WRITTEN_CONFLICT"]
    first, second = sorted(questions, key=lambda question: question.line_codes)
    assert first.line_codes == ["01.0010"] and "7 m" in first.text_de and "8 m" in first.text_de
    assert second.line_codes == ["01.0020"] and "9 m" in second.text_de and "7 m" not in second.text_de
