import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

import workspace_analysis
import workspace_bid_pricing
from analysis.adapter import from_file
from analysis.contracts import Finding, Target

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
    monkeypatch.setattr(workspace_analysis, "_source", lambda *args: source.model_copy(deep=True))
    record = {"document": document, "report": None, "patch": None}
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = record
    return connection, record, source


def test_bid_simulator_uses_original_quantities_and_detected_shortfall(monkeypatch):
    connection, record, _ = tender(monkeypatch)
    upload = workspace_analysis._uploaded_input(record["document"])
    record["report"] = workspace_analysis.run(
        {**upload, "layers": [1, 2]}, connection, "default", "example",
        filename=record["document"]["fileName"], original_upload=True,
    )
    finding = next(f for f in record["report"]["findings"] if f["rule_id"] == "L2.SANITARY.WC_NEEDS_WC_SEAT")
    review = Finding.create(rule_id="L3.REVIEW.L2_CONFIRM", layer=3, scope=finding["scope"],
                            target=Target.model_validate(finding["target"]), category="dependency", origin="llm", severity="info",
                            title="AI review", message="Possible coverage elsewhere",
                            evidence={"reviews_finding_id": finding["id"], "verdict": "included"})
    record["report"]["findings"].append(review.model_dump(mode="json"))
    # A saved, matching assessment is reusable without rerunning the analysis or external AI.
    monkeypatch.setattr(workspace_bid_pricing, "analyze", lambda *args, **kwargs: pytest.fail("re-ran assessment"))
    options = workspace_bid_pricing.run(connection, "default", "example")
    assert options["positions"][1]["quantity"] == 3
    opportunity, = options["opportunities"]
    assert opportunity["position"] == "01.0020" and opportunity["quantity"] == 7
    assert opportunity["ai_reviewed"]
    assert options["input_hash"] == record["report"]["input_hash"]

    assumptions = json.loads((FIXTURES / "sanitary.json").read_text())
    request = {"input_hash": options["input_hash"], "assumptions": assumptions}
    result = workspace_bid_pricing.run(connection, "default", "example", request)
    assert str(result["strategies"]["quantity_aware"]["expected_profit"]) == "391.60"
    assert result["strategies"]["quantity_aware"]["bid_total"] == 2756

    record["patch"] = {"findingDecisions": {review.id: {"status": "accepted"}}}
    assert not workspace_bid_pricing.run(connection, "default", "example")["opportunities"]
    with pytest.raises(ValueError, match="accepted review"):
        workspace_bid_pricing.run(connection, "default", "example", request)
    record["patch"]["findingDecisions"][review.id]["status"] = "dismissed"
    restored, = workspace_bid_pricing.run(connection, "default", "example")["opportunities"]
    assert not restored["ai_reviewed"]

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
