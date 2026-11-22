import json
from pathlib import Path
from unittest.mock import Mock

import pytest

import workspace_analysis
import workspace_bid_pricing
from analysis.adapter import from_file
from analysis.layer3.prompts import RELATIONSHIP_VERSION
from analysis.layer3.provider import FakeProvider, ResponseCache
from analysis.runner import analyze

FIXTURES = Path(__file__).resolve().parents[2] / "data" / "examples" / "bid-pricing"


def tender(monkeypatch, filename="sanitary.X83", source=None):
    source = source or from_file(FIXTURES / filename)
    document = {
        "phase": "X83", "currency": "EUR", "fileName": filename, "title": source.bom.title,
        "source": {"kind": "gaeb-xml"},
        "positions": [
            {"id": f"row-{i}", "oz": line.code, "short": line.short_text, "long": line.long_text,
             "qty": int(line.quantity), "unit": line.unit_raw,
             "path": [{"oz": "01", "label": source.bom.title}]}
            for i, line in enumerate(source.lines)
        ],
    }
    monkeypatch.setattr(workspace_analysis, "_source", lambda *args: source)
    record = {"document": document, "report": None, "patch": None}
    connection = Mock()
    connection.execute.return_value.fetchone.return_value = record
    return connection, record, source


def test_bid_simulator_uses_original_quantities_and_detected_shortfall(monkeypatch):
    connection, record, source = tender(monkeypatch)
    upload = workspace_analysis._uploaded_input(record["document"])
    snapshot, _ = workspace_analysis.prepare(upload)
    workspace_analysis._attach_source(snapshot, source, upload["original_codes"])
    record["report"] = analyze(snapshot.with_hash()).model_dump(mode="json")
    # A saved, matching assessment is reusable without rerunning the analysis or external AI.
    monkeypatch.setattr(workspace_bid_pricing, "analyze", lambda *args, **kwargs: pytest.fail("re-ran assessment"))
    options = workspace_bid_pricing.run(connection, "default", "example")
    assert options["positions"][1]["quantity"] == 3
    opportunity, = options["opportunities"]
    assert opportunity["position"] == "01.0020" and opportunity["quantity"] == 7

    assumptions = json.loads((FIXTURES / "sanitary.json").read_text())
    request = {"input_hash": options["input_hash"], "assumptions": assumptions}
    result = workspace_bid_pricing.run(connection, "default", "example", request)
    assert str(result["strategies"]["quantity_aware"]["expected_profit"]) == "391.60"
    assert result["strategies"]["quantity_aware"]["bid_total"] == 2756

    record["patch"] = {"findingDecisions": {opportunity["finding_id"]: {"status": "dismissed"}}}
    assert not workspace_bid_pricing.run(connection, "default", "example")["opportunities"]
    with pytest.raises(ValueError, match="shortfall"):
        workspace_bid_pricing.run(connection, "default", "example", request)


def test_bid_simulator_rejects_a_stale_or_mismatched_tender(monkeypatch):
    connection, record, _ = tender(monkeypatch)
    with pytest.raises(ValueError, match="tender has changed"):
        workspace_bid_pricing.run(connection, "default", "example", {"input_hash": "stale"})
    record["document"]["positions"][0]["qty"] = 100
    with pytest.raises(ValueError, match="could not be reconciled"):
        workspace_bid_pricing.run(connection, "default", "example")


@pytest.mark.parametrize(("classroom", "ratio", "listed", "extra"), [(True, 4, 20, 20), (False, 3, 3, 27)])
def test_x83_relationship_flows_through_saved_assessment_and_pricing(monkeypatch, tmp_path, classroom, ratio, listed, extra):
    original = FIXTURES / "tables-and-chairs.X83"
    quote = "Provide four chairs per table." if classroom else "Provide three chairs per table."
    if classroom:
        filename = tmp_path / "classroom.X83"
        filename.write_text(original.read_text().replace("dining", "classroom").replace(
            "Provide three chairs per table.", quote).replace(">3.000<", ">20.000<"))
    else:
        filename = original
    connection, record, source = tender(monkeypatch, filename.name, from_file(filename))
    proposal = {"source_ref": "P1", "quote": quote, "base_ref": "P1", "base_item": "table",
                "dependent_ref": "P2", "dependent_item": "chairs", "ratio": str(ratio), "qualifier": None}
    provider = FakeProvider(lambda request: {"relationships": [proposal, proposal]}
                            if request.prompt_version == RELATIONSHIP_VERSION
                            else {key: [] for key in request.schema["required"]})
    monkeypatch.setattr("analysis.layer3.provider_from_env", lambda: provider)
    monkeypatch.setattr("analysis.layer3.audit_provider_from_env", lambda main: main)
    monkeypatch.setattr("analysis.layer3.cache_from_env", lambda: ResponseCache(None))
    upload = workspace_analysis._uploaded_input(record["document"])
    record["report"] = workspace_analysis.run({**upload, "layers": [1, 2, 3]}, connection, "default",
                                               "example", filename=filename.name)
    assert record["report"]["used_source"]
    monkeypatch.setattr(workspace_bid_pricing, "analyze", lambda *args, **kwargs: pytest.fail("re-ran assessment"))
    options = workspace_bid_pricing.run(connection, "default", "example")
    opportunity, = options["opportunities"]
    assert opportunity["position_id"] == "row-1" and opportunity["quantity"] == extra
    finding = next(item for item in record["report"]["findings"] if item["id"] == opportunity["finding_id"])
    assert finding["related_line_ids"] == ["row-0"]
    assert quote in finding["message"]
    assert f"10 × {ratio} = {10 * ratio} required, {listed} listed, +{extra}" in finding["message"]

    assumptions = json.loads(original.with_suffix(".json").read_text())
    for scenario in assumptions["scenarios"]:
        if change := scenario.get("changes", {}).get("01.0020"):
            change.pop("finding_rule")
            change["finding_id"] = opportunity["finding_id"]
        if classroom:
            scenario["winning_bid_ceiling"] = "1850"
    request = {"input_hash": options["input_hash"], "assumptions": assumptions}
    result = workspace_bid_pricing.run(connection, "default", "example", request)
    if not classroom:
        strategies = result["strategies"]
        assert strategies["quantity_aware"]["bid_total"] == strategies["price_only"]["bid_total"] == 1120
        assert strategies["quantity_aware"]["expected_profit"] == 492
        assert strategies["price_only"]["expected_profit"] == 276
    for scenario in assumptions["scenarios"]:
        if change := scenario.get("changes", {}).get("01.0020"):
            change.update(quoted_rate_share="0", other_unit_rate="20")
    strategies = workspace_bid_pricing.run(connection, "default", "example", request)["strategies"]
    assert strategies["quantity_aware"]["expected_profit"] == strategies["price_only"]["expected_profit"]
    if not classroom:
        assert strategies["quantity_aware"]["expected_profit"] == 60
        for scenario in assumptions["scenarios"]:
            if change := scenario.get("changes", {}).get("01.0020"):
                change["other_unit_rate"] = "25"
        strategies = workspace_bid_pricing.run(connection, "default", "example", request)["strategies"]
        assert strategies["quantity_aware"]["expected_profit"] == strategies["price_only"]["expected_profit"] == 168
    assumptions["prices"].pop("01.0020")
    with pytest.raises(ValueError, match="Missing pricing assumptions"):
        workspace_bid_pricing.run(connection, "default", "example", request)


def test_stale_saved_relationship_cannot_be_selected_after_working_text_edit(monkeypatch):
    connection, record, source = tender(monkeypatch, "tables-and-chairs.X83")
    upload = workspace_analysis._uploaded_input(record["document"])
    snapshot, _ = workspace_analysis.prepare(upload)
    workspace_analysis._attach_source(snapshot, source, upload["original_codes"])
    old_hash = snapshot.compute_hash()
    proposal = {"source_ref": "P1", "quote": "Provide three chairs per table.", "base_ref": "P1",
                "base_item": "table", "dependent_ref": "P2", "dependent_item": "chairs",
                "ratio": "3", "qualifier": None}
    provider = FakeProvider(lambda request: {"relationships": [proposal]} if request.prompt_version == RELATIONSHIP_VERSION
                            else {key: [] for key in request.schema["required"]})
    record["report"] = analyze(snapshot.with_hash(), (1, 2, 3), layer3_provider=provider).model_dump(mode="json")
    assert workspace_bid_pricing.run(connection, "default", "example")["opportunities"]
    record["edits"] = {"patch": {"row-0": {"long": "Supply tables and chairs. Confirm the ratio."}}}
    with pytest.raises(ValueError, match="tender has changed"):
        workspace_bid_pricing.run(connection, "default", "example", {"input_hash": old_hash})
    options = workspace_bid_pricing.run(connection, "default", "example")
    assert options["input_hash"] != old_hash
    assert options["opportunities"] == []


def test_working_quantity_edit_retains_original_manual_simulation(monkeypatch):
    connection, record, _ = tender(monkeypatch)
    original = workspace_bid_pricing.run(connection, "default", "example")
    record["edits"] = {"qty": {"row-1": 5}}
    options = workspace_bid_pricing.run(connection, "default", "example")
    assert options["manual_only"] and options["input_hash"] != original["input_hash"]
    assert options["positions"][1]["quantity"] == 3
    assert options["opportunities"] == []
    assumptions = json.loads((FIXTURES / "sanitary.json").read_text())
    request = {"input_hash": options["input_hash"], "assumptions": assumptions}
    with pytest.raises(ValueError, match="shortfall"):
        workspace_bid_pricing.run(connection, "default", "example", request)
    for scenario in assumptions["scenarios"]:
        if change := scenario.get("changes", {}).get("01.0020"):
            change.pop("finding_rule")
            change["extra_quantity"] = "7"
    assert workspace_bid_pricing.run(connection, "default", "example", request)["strategies"]["quantity_aware"]["bid_total"] == 2756
