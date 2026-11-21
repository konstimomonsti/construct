"""Read the uploaded X83 and simulate a bid without persisting commercial assumptions."""

from collections import Counter

import workspace_analysis
from analysis.bid_pricing import PricingAssumptions, included_positions, quantity_opportunities, report
from analysis.contracts import AnalysisResult
from analysis.runner import DEFAULT_LAYERS, analyze
from workspace_product_evidence import add_to_snapshot

MAX_SCENARIOS = 12


def _signature(line):
    return workspace_analysis._code(line.code), line.quantity, line.unit, line.pricing_basis, line.total_rule


def _assessment(snapshot, record):
    stored = record["report"]
    if stored and stored.get("input_hash") == snapshot.input_hash:
        assessment = AnalysisResult.model_validate({key: value for key, value in stored.items()
                                                    if key in AnalysisResult.model_fields})
    else:
        assessment = analyze(snapshot, DEFAULT_LAYERS, include_risk=False)
    decisions = (record["patch"] or {}).get("findingDecisions") or {}
    for finding in assessment.findings:
        decision = (decisions.get(finding.id) or {}).get("status")
        if decision == "dismissed":
            finding.status = "rejected"
        elif decision == "accepted":
            finding.status = "accepted"
    return assessment


def run(connection, workspace, list_id, payload=None):
    record = connection.execute(
        """
        SELECT original.value AS document, patch.value AS patch, assessment.report
        FROM workspace_record original
        LEFT JOIN workspace_record patch
          ON (patch.workspace, patch.collection, patch.record_id)=(original.workspace, 'listPatch', original.record_id)
        LEFT JOIN workspace_assessment assessment
          ON (assessment.workspace, assessment.list_id)=(original.workspace, original.record_id)
          AND assessment.state='ready'
        WHERE original.workspace=%s AND original.collection='userLists' AND original.record_id=%s
        """,
        (workspace, list_id),
    ).fetchone()
    if not record:
        raise LookupError("Imported tender not found.")
    document = record["document"]
    if document.get("phase") != "X83" or (document.get("source") or {}).get("kind") != "gaeb-xml":
        raise ValueError("Open an imported GAEB X83 tender to simulate a bid.")
    source = workspace_analysis._source(connection, workspace, list_id, None, document["fileName"])
    if not source or source.project.gaeb_phase != "83":
        raise LookupError("Original X83 unavailable. Wait for the upload to sync and try again.")
    included_positions(source)  # Check original section totals before rebuilding the upload assessment snapshot.
    upload = workspace_analysis._uploaded_input(document)
    snapshot, _ = workspace_analysis.prepare({**upload, "layers": list(DEFAULT_LAYERS)})
    workspace_analysis._attach_source(snapshot, source, upload["original_codes"])
    if Counter(map(_signature, snapshot.lines)) != Counter(map(_signature, source.lines)):
        raise ValueError("Workspace positions could not be reconciled with the original X83 quantities and units.")
    snapshot = workspace_analysis._original_tender(snapshot, source, upload["original_refs"])
    add_to_snapshot(connection, workspace, list_id, snapshot)
    snapshot = snapshot.with_hash()
    assessment = _assessment(snapshot, record)
    currency = source.project.currency or snapshot.project.currency or "EUR"
    if payload is not None:
        if payload.get("input_hash") != snapshot.input_hash:
            raise ValueError("The tender has changed. Reopen the simulator to load it again.")
        assumptions = PricingAssumptions.model_validate(payload.get("assumptions"))
        if assumptions.currency != currency:
            raise ValueError("Use the tender currency for the bid simulation.")
        if len(assumptions.scenarios) > MAX_SCENARIOS:
            raise ValueError(f"Enter at most {MAX_SCENARIOS} award and quantity scenarios.")
        return report(snapshot, assessment, assumptions)

    return {
        "input_hash": snapshot.input_hash,
        "currency": currency,
        "assessment_layers": assessment.layers_run,
        "positions": [
            {"key": key, "id": line.id, "text": line.short_text, "quantity": quantity,
             "unit": line.unit_raw or line.unit, "can_change_quantity": line.pricing_basis == "unit_rate" and bool(line.unit)}
            for key, (line, quantity) in included_positions(snapshot).items()
        ],
        "opportunities": quantity_opportunities(snapshot, assessment),
    }
