"""The evaluation harness: seed, X83 writer, mutator with read-back, labels, scoring and the CLI."""

import json
from pathlib import Path

import pytest

from analysis import adapter
from analysis.eval import SEED_PATH, catalogue, docio, gaeb_writer, labels, mutate, ops
from analysis.eval.cli import main as eval_main
from analysis.eval.harness import evaluate, run_all
from analysis.eval.report import format_report
from analysis.eval.seeds import make_building_hall
from analysis.layer2.schema import load_rules
from analysis.runner import analyze


@pytest.fixture(scope="module")
def seed_doc():
    return docio.load(SEED_PATH)


# --------------------------------------------------------------------------- seed and writer


def test_seed_is_the_generated_one():
    assert docio.loads(SEED_PATH.read_text(encoding="utf-8")) == make_building_hall.build()


def test_seed_is_german_priced_and_about_sixty_lines(seed_doc):
    assert 55 <= len(seed_doc["lines"]) <= 70
    text = " ".join(line["short_text"] for line in seed_doc["lines"]).casefold()
    for word in ("estrich", "beton", "metallständerwand", "dispersionsfarbe", "dachabdichtung"):
        assert word in text
    assert all(docio.line_amount(line) == docio.expected_line_amount(line) for line in seed_doc["lines"])
    assert seed_doc["bom"]["stated_net_total"] == docio.net_sum(seed_doc)


def test_clean_seed_gives_no_findings_at_all():
    result = analyze(adapter.from_json(SEED_PATH), [1, 2])
    assert result.errors == []
    assert result.findings == []


def test_every_layer2_dependency_of_the_five_trades_is_present_exactly_once(seed_doc):
    ctx = catalogue.Context(seed_doc, 1)
    seen = 0
    for rule, dependency in ctx.dependencies():
        if not ctx.triggers(seed_doc, rule):
            continue  # a trade the seed does not contain
        seen += 1
        assert len(ctx.matches(seed_doc, dependency)) == 1, f"{rule.rule_id} / {dependency.name}"
    assert seen == 16
    assert {rule.rule_id for rule in load_rules() if ctx.triggers(seed_doc, rule)} == {
        "L2.FLOOR.SCREED", "L2.CONCRETE.STRUCTURE", "L2.DRYWALL.PARTITION", "L2.PAINT.COATING",
        "L2.ROOF.WATERPROOFING"}


def test_x83_export_reads_back_as_the_seed(tmp_path, seed_doc):
    path = gaeb_writer.write_file(seed_doc, tmp_path / "seed.X83")
    from_x83 = adapter.from_file(path)
    assert from_x83.project.gaeb_phase == "83"
    assert from_x83.import_warnings == []
    assert ops.diff(ops.canon_from_input(adapter.from_json(SEED_PATH)), ops.canon_from_input(from_x83)) == set()
    assert analyze(from_x83, [1, 2]).findings == []


# --------------------------------------------------------------------------- mutator


def test_mutation_is_reproducible_and_depends_on_the_seed(tmp_path):
    first = mutate.generate(out_dir=tmp_path / "a", seed=7, per_type=2, only={"QTY-ZERO", "DUP-NEW-OZ"}, demo=False)
    mutate.generate(out_dir=tmp_path / "b", seed=7, per_type=2, only={"QTY-ZERO", "DUP-NEW-OZ"}, demo=False)
    for entry in first["files"]:
        assert (tmp_path / "a" / "mutated" / entry["file"]).read_bytes() == (tmp_path / "b" / "mutated" / entry["file"]).read_bytes()
        labels_a = (tmp_path / "a" / "mutated" / (entry["file"] + ".labels.json")).read_bytes()
        assert labels_a == (tmp_path / "b" / "mutated" / (entry["file"] + ".labels.json")).read_bytes()
    doc = docio.load(SEED_PATH)
    targets = {seed: [p.description for p in catalogue.plan_all(doc, seed, 3, {"QTY-ZERO"})] for seed in (1, 2, 3)}
    assert len({tuple(value) for value in targets.values()}) > 1


def test_every_mutation_changes_exactly_one_thing(tmp_path, seed_doc):
    """One planted change per file; the read-back check inside generate() enforces it for the whole catalogue."""
    manifest = mutate.generate(out_dir=tmp_path, seed=1, per_type=1, backends=("x83", "json"))
    types = {entry["type"] for entry in manifest["files"]}
    assert types >= {t.name for t in catalogue.TYPES} | {"CTRL-CLEAN", "DEMO"}
    for plan in catalogue.plan_all(seed_doc, 1, 1):
        planted = [op for op in plan.ops if not op.get("derived")]
        if plan.whitespace_only:
            continue
        assert planted, plan.id
        # Only plain arithmetic follows from the planted change.
        assert all(op["op"] in ("set", "section_total", "net_total") for op in plan.ops if op.get("derived"))


def test_readback_rejects_a_file_with_an_unplanned_change(tmp_path, seed_doc):
    plan = next(p for p in catalogue.plan_all(seed_doc, 1, 1) if p.type == "QTY-ZERO")
    data, _ = mutate.render(seed_doc, plan.ops, "x83")
    path = tmp_path / "tampered.X83"
    path.write_bytes(data)
    mutate.check_readback(path, "x83", seed_doc, plan.ops)  # fine as written
    other = next(l for l in seed_doc["lines"] if l["code"] == "01.01.0010")
    tampered = gaeb_writer.build_tree(seed_doc)
    ops.apply_to_tree(tampered, plan.ops + [{"op": "set", "id": other["id"], "field": "short_text", "value": "Anderer Text"}])
    path.write_bytes(gaeb_writer.serialize(tampered))
    with pytest.raises(mutate.ReadbackError):
        mutate.check_readback(path, "x83", seed_doc, plan.ops)


def test_dependency_is_removed_only_if_no_remaining_text_names_it(seed_doc):
    ctx = catalogue.Context(seed_doc, 1)
    plans = {p.id: p for p in catalogue.plan_all(seed_doc, 1, 1, {"L2-REMOVE"})}
    assert len(plans) == 16
    for plan in plans.values():
        remaining = ops.apply_to_doc(seed_doc, plan.ops)
        rule = next(r for r in ctx.rules if r.rule_id == plan.params["rule"])
        dependency = next(d for d in rule.dependencies if d.name == plan.params["dependency"])
        assert ctx.matches(remaining, dependency) == []


def test_gaps_and_controls_are_labelled(seed_doc):
    plans = catalogue.plan_all(seed_doc, 1, 1)
    by_type = {p.type: p for p in plans}
    for name in ("DUP-REWORDED", "TEXT-TYPO", "TEXT-VAGUE", "TEXT-CONFLICT-CLASS", "TEXT-CONFLICT-DN"):
        assert by_type[name].label["gap"] is True and by_type[name].label["expect"]
    conflict = by_type["TEXT-CONFLICT-CLASS"].label
    assert "L1.TEXT.VALUE_CONFLICT" in conflict["expect"] and conflict["layers"] == [1, 3]
    for name in ("CTRL-INLINE", "CTRL-REORDER", "CTRL-WHITESPACE", "CTRL-PLUS5"):
        assert by_type[name].label["control"] is True and by_type[name].label["expect"] == []


def test_labels_key_on_codes_never_on_finding_ids(tmp_path):
    mutate.generate(out_dir=tmp_path, seed=1, per_type=1, only={"QTY-ZERO", "L2-REMOVE"}, backends=("x83",), demo=False)
    for path in (tmp_path / "mutated").glob("*.labels.json"):
        payload = labels.load(path)
        assert payload["schema"] == "construct-eval-labels/1"
        text = path.read_text(encoding="utf-8")
        assert '"f_' not in text and "finding_id" not in text
        for entry in payload["labels"]:
            assert set(entry) >= {"target", "expect", "match", "also_acceptable", "gap", "control", "layers"}


# --------------------------------------------------------------------------- matching and scoring


def finding(rule_id, **fields):
    base = {"rule_id": rule_id, "layer": int(rule_id[1]), "severity": "error", "scope": "line", "line_code": None,
            "section_code": None, "field": None, "trigger_codes": [], "related_codes": [], "title": "", "message": ""}
    return {**base, **fields}


def test_finding_matching_modes():
    line = {"target": {"line_codes": ["01.0010"]}, "expect": ["L1.QTY.*"], "match": "line"}
    assert labels.finding_matches(line, finding("L1.QTY.ZERO", line_code="01.0010"))
    assert not labels.finding_matches(line, finding("L1.QTY.ZERO", line_code="01.0020"))
    assert not labels.finding_matches(line, finding("L1.UNIT.MISSING", line_code="01.0010"))
    section = {"target": {"section_codes": ["02.01"]}, "expect": ["L1.ARITH.SECTION_TOTAL"], "match": "section"}
    assert labels.finding_matches(section, finding("L1.ARITH.SECTION_TOTAL", section_code="02.01", scope="section"))
    dependency = {"target": {"trigger_codes": ["02.02.0010"]}, "expect": ["L2.X_NEEDS_Y"], "match": "dependency"}
    assert labels.finding_matches(dependency, finding("L2.X_NEEDS_Y", scope="bom", trigger_codes=["02.02.0010", "02.02.0020"]))
    assert not labels.finding_matches(dependency, finding("L2.X_NEEDS_Y", scope="bom", trigger_codes=["03.01.0010"]))
    bom = {"target": {}, "expect": ["L1.ARITH.NET_TOTAL"], "match": "bom"}
    assert labels.finding_matches(bom, finding("L1.ARITH.NET_TOTAL", scope="bom"))
    assert not labels.finding_matches({"target": {}, "expect": [], "match": "none"}, finding("L1.QTY.ZERO"))


@pytest.fixture(scope="module")
def evaluated(tmp_path_factory):
    out = tmp_path_factory.mktemp("eval")
    mutate.generate(out_dir=out, seed=1, per_type=1, backends=("x83",))
    run_all(out, [1, 2])
    return out, evaluate(out)


def test_end_to_end_catches_every_detectable_error_with_no_false_alarm(evaluated):
    _, evaluation = evaluated
    outcomes = {}
    for o in evaluation.outcomes:
        outcomes.setdefault(o.label["mutation_type"], set()).add(o.outcome)
    gaps = {t.name for t in catalogue.TYPES if t.gap}
    for name, found in outcomes.items():
        if name in gaps:
            assert found == {"gap"}, name
        elif name.startswith("CTRL"):
            assert found == {"clean"}, name
        else:
            assert found == {"caught"}, (name, found)
    assert evaluation.false_alarms == []
    assert evaluation.baseline_findings == {"building_hall_clean.X83": 0}
    assert all(o.outcome == "caught" for o in evaluation.outcomes if o.suite == "demo")


def test_report_has_recall_precision_controls_and_gaps(evaluated):
    out, evaluation = evaluated
    text = format_report(evaluation)
    for heading in ("Recall per mutation type", "Controls", "Precision per rule", "Known gaps", "Presenter files"):
        assert heading in text
    assert "Excluding the known gaps" in text and "`L1.QTY.ZERO`" in text
    assert "TEXT-TYPO" in text and "(gap)" in text


def test_a_missed_error_and_a_false_alarm_are_reported(evaluated, tmp_path):
    out, _ = evaluated
    import shutil
    copy = tmp_path / "copy"
    shutil.copytree(out, copy)
    # Missed: the label asks for a rule that did not fire.
    labels_path = copy / "mutated" / "QTY-ZERO-01.X83.labels.json"
    payload = json.loads(labels_path.read_text(encoding="utf-8"))
    payload["labels"][0]["expect"] = ["L1.DOES.NOT_EXIST"]
    labels_path.write_text(json.dumps(payload), encoding="utf-8")
    # False alarm: a control file gains a finding in its stored result.
    result_path = next((copy / "results").glob("mutated__CTRL-REORDER-01.X83.json"))
    result = json.loads(result_path.read_text(encoding="utf-8"))
    result["findings"].append(finding("L1.QTY.ZERO", line_code="01.01.0010"))
    result_path.write_text(json.dumps(result), encoding="utf-8")
    evaluation = evaluate(copy)
    by_file = {o.file: o.outcome for o in evaluation.outcomes}
    assert by_file["QTY-ZERO-01.X83"] == "missed"
    assert by_file["CTRL-REORDER-01.X83"] == "false_alarm"
    assert ("CTRL-REORDER-01.X83", result["findings"][-1]) in evaluation.false_alarms
    # The control's invented finding, plus the real L1.QTY.ZERO of QTY-ZERO-01 which its altered label no longer expects.
    assert evaluation.per_rule["L1.QTY.ZERO"]["fp"] == 2


def test_a_label_whose_layer_did_not_run_counts_as_not_run(tmp_path, monkeypatch):
    mutate.generate(out_dir=tmp_path, seed=1, per_type=1, only={"QTY-ZERO"}, backends=("x83",), demo=False)
    labels_path = tmp_path / "mutated" / "QTY-ZERO-01.X83.labels.json"
    payload = json.loads(labels_path.read_text(encoding="utf-8"))
    payload["labels"][0].update(expect=["L3.TEXT.SHORT_LONG_CONTRADICTION"], layers=[3])
    labels_path.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setenv("ANALYSIS_L3_PROVIDER", "none")  # layer 3 is asked for but has no model
    run_all(tmp_path, [1, 2, 3])
    evaluation = evaluate(tmp_path)
    assert {o.file: o.outcome for o in evaluation.outcomes}["QTY-ZERO-01.X83"] == "not_run"
    assert 3 in evaluation.layers_not_run
    assert "Not run: 3" in format_report(evaluation)


def test_baseline_is_subtracted(tmp_path):
    """A finding the clean file already has is not the mutation's doing."""
    from analysis.eval.harness import new_findings
    old = {"findings": [finding("L1.QTY.ZERO", line_code="A")]}
    new = {"findings": [finding("L1.QTY.ZERO", line_code="A"), finding("L1.QTY.ZERO", line_code="B")]}
    assert [f["line_code"] for f in new_findings(old, new)] == ["B"]


# --------------------------------------------------------------------------- CLI


def test_cli_end_to_end(tmp_path, capsys):
    out = str(tmp_path / "eval_out")
    assert eval_main(["mutate", "--out", out, "--backend", "x83", "--per-type", "1", "--only", "QTY-ZERO,CTRL"]) == 0
    assert eval_main(["run", "--out", out]) == 0
    assert eval_main(["fp", "--out", out]) == 0
    assert eval_main(["report", "--out", out, "--write", str(tmp_path / "report.md")]) == 0
    printed = capsys.readouterr().out
    assert "Recall per mutation type" in printed and "0 false alarms" in printed
    assert (tmp_path / "report.md").read_text(encoding="utf-8").startswith("Evaluated")


def test_label_template_groups_findings_per_rule(tmp_path, capsys):
    mutate.generate(out_dir=tmp_path, seed=1, per_type=1, only={"QTY-ZERO"}, backends=("x83",), demo=False)
    assert eval_main(["label-template", str(tmp_path / "mutated" / "QTY-ZERO-01.X83")]) == 0
    lines = capsys.readouterr().out.strip().splitlines()
    assert lines[0] == "file,rule_id,finding_id,verdict,note"
    assert lines[1].startswith("QTY-ZERO-01.X83,L1.QTY.ZERO,*,,")


def test_precast_seed_and_mutations_round_trip_cleanly(tmp_path):
    from analysis.eval import PRECAST_PATH, precast
    from analysis.eval.seeds.make_precast_lv11 import build

    assert json.loads(PRECAST_PATH.read_text(encoding="utf-8")) == build()
    baseline = analyze(adapter.from_json(PRECAST_PATH), [1, 2])
    assert not baseline.errors
    assert not [f for f in baseline.findings if f.severity in {"error", "warning"}]

    # One building-hall type keeps this test quick while exercising both format paths for precast.
    mutate.generate(out_dir=tmp_path, only={"QTY-ZERO"}, per_type=1, include_precast=True, demo=False)
    run_all(tmp_path, [1, 2])
    evaluation = evaluate(tmp_path)
    rendered = format_report(evaluation)
    assert "Dämmstoffdicke 10 cm" in rendered
    assert "Unrelated traffic-control quantity increases by 5%" in rendered
    assert "L3.PRECAST.MISSING_SPEC" in rendered
    assert not evaluation.false_alarms
    for backend in ("x83", "json"):
        results = {row.label["mutation_type"]: row.outcome for row in evaluation.outcomes if row.backend == backend}
        for plan in precast.plans(docio.load(PRECAST_PATH)):
            assert plan.type in results
        assert results["PRECAST-UNIT"] == "caught"
        assert results["PRECAST-MISSING-SPEC"] == results["PRECAST-REBAR-SCOPE"] == "not_run"


def test_generated_demo_files_have_expected_live_findings():
    from analysis.eval.labels import run_file

    folder = Path(__file__).resolve().parents[3] / "data" / "demo"
    building = run_file(folder / "building_hall_planted.X83", [1, 2])
    assert not building["errors"]
    assert {
        "L1.ARITH.LINE_AMOUNT", "L1.DUP.SUSPECTED", "L1.QTY.ZERO", "L2.FLOOR.SCREED_NEEDS_EDGE_INSULATION",
    } <= {finding["rule_id"] for finding in building["findings"]}
    precast = run_file(folder / "precast_lv11_planted.X83", [1, 2])
    assert not precast["errors"]
    assert any(finding["rule_id"] == "L1.UNIT.TEXT_MISMATCH" and finding["line_code"] == "3.2.80"
               for finding in precast["findings"])


def test_layer3_evaluation_refuses_modified_file_or_real_label_request(tmp_path, monkeypatch):
    from analysis.eval import labels

    mutate.generate(out_dir=tmp_path, seed=1, only={"QTY-ZERO"}, per_type=1, backends=("x83",), demo=False)
    path = tmp_path / "mutated" / "QTY-ZERO-01.X83"
    path.write_bytes(path.read_bytes() + b" ")
    monkeypatch.setenv("ANALYSIS_L3_PROVIDER", "none")
    with pytest.raises(ValueError, match="unmodified generated synthetic file"):
        run_all(tmp_path, [1, 2, 3])
    with pytest.raises(ValueError, match="supports layers 1 and 2"):
        labels.template_rows(path, [1, 2, 3])
