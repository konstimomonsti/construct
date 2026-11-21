import json
from pathlib import Path
from unittest.mock import Mock

import pytest

import workspace_analysis
import workspace_bid_pricing
from analysis.adapter import from_file
from analysis.runner import analyze

FIXTURES = Path(__file__).resolve().parents[2] / "data" / "examples" / "bid-pricing"


def tender(monkeypatch):
    source = from_file(FIXTURES / "sanitary.X83")
    document = {
        "phase": "X83", "currency": "EUR", "fileName": "sanitary.X83", "title": "Sanitary fixtures",
        "source": {"kind": "gaeb-xml"},
        "positions": [
            {"id": f"row-{i}", "oz": line.code, "short": line.short_text, "long": line.long_text,
             "qty": int(line.quantity), "unit": line.unit_raw,
             "path": [{"oz": "01", "label": "Sanitary fixtures"}]}
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
