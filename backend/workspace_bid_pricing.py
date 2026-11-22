"""Read the uploaded X83 and simulate a bid without persisting commercial assumptions."""

from collections import Counter

import workspace_analysis
from analysis.bid_pricing import PricingAssumptions, included_positions, quantity_opportunities, report
from analysis.contracts import AnalysisResult
from analysis.quantity_relationships import RULE_ID as RELATIONSHIP_RULE
from analysis.runner import DEFAULT_LAYERS, analyze

MAX_SCENARIOS = 12


def _signature(line):
    return workspace_analysis._code(line.code), line.quantity, line.unit, line.pricing_basis, line.total_rule


def _assessment(snapshot, record):
    stored = record["report"]
    if stored and stored.get("input_hash") == snapshot.input_hash:
        assessment = AnalysisResult.model_validate({key: value for key, value in stored.items()
                                                    if key in AnalysisResult.model_fields})
        review_keys = {item["id"]: item.get("review_key") for item in stored.get("findings", [])}
        reopened = set(stored.get("reopened_finding_ids", []))
    else:
        assessment = analyze(snapshot, DEFAULT_LAYERS, include_risk=False)
        review_keys, reopened = {}, set()
    decisions = (record["patch"] or {}).get("findingDecisions") or {}
    for finding in assessment.findings:
        decision = decisions.get(finding.id) or {}
        decision_key = decision.get("reviewKey")
        current = finding.id not in reopened if decision_key is None else decision_key == review_keys.get(finding.id)
        if decision.get("status") == "dismissed" and current:
            finding.status = "rejected"
    return assessment


def run(connection, workspace, list_id, payload=None):
    record = connection.execute(
        """
        SELECT original.value AS document, patch.value AS patch, edits.value AS edits, assessment.report
        FROM workspace_record original
        LEFT JOIN workspace_record patch
          ON (patch.workspace, patch.collection, patch.record_id)=(original.workspace, 'listPatch', original.record_id)
        LEFT JOIN workspace_record edits
          ON (edits.workspace, edits.collection, edits.record_id)=(original.workspace, 'edits', original.record_id)
        LEFT JOIN workspace_assessment assessment
          ON (assessment.workspace, assessment.list_id)=(original.workspace, original.record_id)
          AND assessment.state='ready' AND assessment.assessed_revision=assessment.revision
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
    original_codes = {pos["id"]: pos["oz"] for pos in document["positions"] if pos.get("oz")}

    def assessed_snapshot(current_document):
        upload = workspace_analysis._uploaded_input(current_document)
        snapshot, _ = workspace_analysis.prepare(upload, allow_empty=True)
        workspace_analysis._attach_source(snapshot, source, original_codes)
        return snapshot.with_hash()

    original_snapshot = assessed_snapshot(document)
    original_signatures = Counter(map(_signature, source.lines))
    if Counter(map(_signature, original_snapshot.lines)) != original_signatures:
        raise ValueError("Workspace positions could not be reconciled with the original X83 quantities and units.")
    working = workspace_analysis._apply_edits(document, record.get("edits"))
    current_snapshot = original_snapshot if working is document else assessed_snapshot(working)
    matches_import = Counter(map(_signature, current_snapshot.lines)) == original_signatures
    snapshot = current_snapshot if matches_import else original_snapshot
    assessment = _assessment(snapshot, record if matches_import else {**record, "report": None})
    if not matches_import:
        # The original tender remains usable for manual simulation after structural edits.
        assessment.findings = []
    currency = source.project.currency or snapshot.project.currency or "EUR"
    if payload is not None:
        if payload.get("input_hash") != current_snapshot.input_hash:
            raise ValueError("The tender has changed. Reopen the simulator to load it again.")
        assumptions = PricingAssumptions.model_validate(payload.get("assumptions"))
        if assumptions.currency != currency:
            raise ValueError("Use the tender currency for the bid simulation.")
        if len(assumptions.scenarios) > MAX_SCENARIOS:
            raise ValueError(f"Enter at most {MAX_SCENARIOS} award and quantity scenarios.")
        if any(change.finding_rule == RELATIONSHIP_RULE
               for scenario in assumptions.scenarios for change in scenario.changes.values()):
            raise ValueError("Select the tender shortfall by its current finding ID.")
        return report(snapshot, assessment, assumptions)

    return {
        "input_hash": current_snapshot.input_hash,
        "currency": currency,
        "manual_only": not matches_import,
        "assessment_layers": assessment.layers_run,
        "positions": [
            {"key": key, "id": line.id, "text": line.short_text, "quantity": quantity,
             "unit": line.unit_raw or line.unit, "can_change_quantity": line.pricing_basis == "unit_rate" and bool(line.unit)}
            for key, (line, quantity) in included_positions(snapshot).items()
        ],
        "opportunities": quantity_opportunities(snapshot, assessment),
    }
