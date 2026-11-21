"""Public v0.2 JSON shape, backward loading, runner isolation and the CLI switch."""

import json
from pathlib import Path

from analysis import adapter, runner
from analysis.__main__ import main
from analysis.contracts import AnalysisInput, AnalysisResult, Finding, Line, Target


def input_data():
    return AnalysisInput(lines=[Line(id="line", code="01.10", sort_order=0, short_text="Leistung", unit="m")])


def test_v01_results_load_with_optional_fields_and_independent_defaults():
    old = {"schema_version": "0.1", "input_hash": "old", "findings": [], "errors": []}
    first, second = AnalysisResult.model_validate(old), AnalysisResult.model_validate(old)
    assert first.schema_version == "0.1" and first.risk is None and first.questions == []
    first.questions.append("local test")
    assert second.questions == []


def test_v02_report_has_exact_fixed_keys_and_decimal_money_serializes_as_text():
    result = runner.analyze(input_data())
    assert result.schema_version == "0.2" and result.risk is not None
    payload = json.loads(result.model_dump_json())
    risk = payload["risk"]
    assert set(risk) == {"version", "score", "level", "scale", "priced", "currency", "money_at_stake", "points",
                         "open_counts", "top_risks", "by_section", "by_category", "change_order_signals"}
    assert risk["version"] == "risk/1" and risk["scale"] == 40
    assert AnalysisResult.model_validate(payload).model_dump(mode="json") == payload
    for top in risk["top_risks"]:
        assert set(top) == {"line_id", "line_code", "short_text", "points", "amount", "reasons", "item_ids"}
    for section in risk["by_section"]:
        assert set(section) == {"section_id", "code", "title", "points", "open"}
    for signal in risk["change_order_signals"]:
        assert set(signal) == {"id", "kind", "line_id", "line_code", "title", "message", "points", "finding_ids"}


def test_risk_and_question_failures_never_discard_layer_findings(monkeypatch):
    inp = input_data()
    expected = runner.analyze(inp, include_risk=False)
    def crash(*args, **kwargs):
        raise RuntimeError("injected risk crash")
    with monkeypatch.context() as patch:
        patch.setattr(runner, "assess", crash)
        result = runner.analyze(inp)
        assert result.findings == expected.findings and result.risk is None
        assert any("injected risk crash" in error for error in result.errors)
    monkeypatch.setattr(runner, "build_questions", crash)
    result = runner.analyze(inp)
    assert result.findings == expected.findings and result.risk is None and result.questions == []


def test_cli_no_risk_keeps_findings_and_new_schema(tmp_path):
    fixture = Path(__file__).parent / "fixtures/lv11_precast.json"
    out = tmp_path / "result.json"
    assert main(["run", str(fixture), "--layers", "1,2", "--no-risk", "--out", str(out)]) == 0
    result = json.loads(out.read_text(encoding="utf-8"))
    assert result["schema_version"] == "0.2" and result["risk"] is None and result["questions"] == []
    assert "findings" in result


def test_mvp_latest_recomputes_from_saved_findings_and_review_states(monkeypatch):
    import analysis_api
    inp = input_data()
    findings = [Finding(id="open", rule_id="L1.QTY.MISSING", layer=1, category="completeness", severity="warning",
                        scope="line", target=Target(line_id="line"), title="Menge fehlt", message="m"),
                Finding(id="rejected", rule_id="L1.UNIT.MISSING", layer=1, category="unit", severity="error",
                        status="rejected", scope="line", target=Target(line_id="line"), title="Einheit fehlt", message="m")]
    class Connection:
        def execute(self, *args):
            return self
        def fetchone(self):
            return {"id": "saved", "input_hash": inp.compute_hash()}
    monkeypatch.setattr(analysis_api, "_input", lambda *args: inp)
    monkeypatch.setattr(analysis_api, "_findings", lambda *args: [
        {**finding.model_dump(mode="json"), "decided_by": None, "decided_at": None} for finding in findings])
    result = analysis_api.latest(Connection(), "version")
    assert set(result["risk"]["points"]) == {"open"}
    assert result["questions"][0]["finding_ids"] == ["open"]
    assert not result["outdated"]
