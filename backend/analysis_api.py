"""Run the analysis pipeline (analysis/) on a stored BOM and keep runs and review decisions.

Tables come from db/migrations/009_analysis.sql. A finding keeps its stable key across runs, so a
reviewer's accept/reject decision carries over to the next run of the same BOM.
"""

import importlib
import os

from psycopg.rows import tuple_row
from psycopg.types.json import Jsonb

from analysis import adapter
from analysis.registry import all_rules
from analysis.runner import DEFAULT_LAYERS, analyze

LAYERS = (1, 2, 3)
DECISIONS = {"open", "accepted", "rejected"}


def _load_layers():
    for layer in LAYERS:
        try:
            importlib.import_module(f"analysis.layer{layer}")
        except ModuleNotFoundError as error:
            if error.name != f"analysis.layer{layer}":
                raise


def rules():
    _load_layers()
    provider = os.environ.get("ANALYSIS_L3_PROVIDER", "ollama").strip().lower()
    return {"rules": [info.as_dict() for info in all_rules()], "default_layers": list(DEFAULT_LAYERS),
            "layer3_provider": provider}


def _input(connection, version_id):
    previous_factory = connection.row_factory
    connection.row_factory = tuple_row
    try:
        return adapter.from_db(connection, str(version_id))
    finally:
        connection.row_factory = previous_factory


def _findings(connection, run_id):
    rows = connection.execute(
        """SELECT payload, status, decided_by, decided_at FROM analysis_finding
           WHERE run_id=%s ORDER BY (payload->>'layer')::int, finding_key""", (run_id,),
    ).fetchall()
    order = {"error": 0, "warning": 1, "info": 2}
    findings = [{**row["payload"], "status": row["status"], "decided_by": row["decided_by"],
                 "decided_at": row["decided_at"]} for row in rows]
    return sorted(findings, key=lambda f: order.get(f.get("severity"), 9))


def run(connection, version_id, payload):
    layers = payload.get("layers", list(DEFAULT_LAYERS))
    if (not isinstance(layers, list) or not layers
            or any(type(layer) is not int or layer not in LAYERS for layer in layers)):
        raise ValueError("Choose analysis layers from 1, 2 and 3.")
    with connection.transaction():
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        snapshot = _input(connection, version_id)
    result = analyze(snapshot, layers)
    with connection.transaction():
        connection.execute("SELECT id FROM bom_version WHERE id=%s FOR NO KEY UPDATE", (version_id,))
        connection.execute(
            """INSERT INTO analysis_run (id, bom_version_id, schema_version, input_hash, layers_run, summary, created_at)
               VALUES (%s, %s, %s, %s, %s, %s, clock_timestamp())""",
            (result.run_id, version_id, result.schema_version, result.input_hash, result.layers_run,
             Jsonb({**result.summary.model_dump(mode="json"), "errors": result.errors})),
        )
        # Carry forward the latest review state, including findings that were reopened.
        decisions = {row["finding_key"]: row for row in connection.execute(
            """SELECT DISTINCT ON (f.finding_key) f.finding_key, f.status, f.decided_by, f.decided_at
               FROM analysis_finding f JOIN analysis_run r ON r.id=f.run_id
               WHERE f.bom_version_id=%s AND r.id<>%s
               ORDER BY f.finding_key, r.created_at DESC, r.id DESC""", (version_id, result.run_id),
        )}
        line_ids = {str(row["id"]) for row in connection.execute(
            "SELECT id FROM bom_line WHERE bom_version_id=%s", (version_id,))}
        with connection.cursor() as cursor:
            cursor.executemany(
                """INSERT INTO analysis_finding (run_id, finding_key, bom_version_id, layer, rule_id, severity,
                       status, bom_line_id, payload, decided_by, decided_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                [(result.run_id, finding.id, version_id, finding.layer, finding.rule_id, finding.severity,
                  decisions.get(finding.id, {}).get("status", "open"),
                  finding.target.line_id if finding.target.line_id in line_ids else None,
                  Jsonb(finding.model_dump(mode="json")),
                  decisions.get(finding.id, {}).get("decided_by"),
                  decisions.get(finding.id, {}).get("decided_at"))
                 for finding in result.findings],
            )
    with connection.transaction():
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        return latest(connection, version_id)


def latest(connection, version_id):
    """The newest run for a BOM with its findings, or run=None when it was never analysed."""
    run_row = connection.execute(
        """SELECT id, schema_version, input_hash, layers_run, summary, created_at FROM analysis_run
           WHERE bom_version_id=%s ORDER BY created_at DESC, id DESC LIMIT 1""", (version_id,),
    ).fetchone()
    if not run_row:
        return {"run": None, "findings": [], "outdated": False}
    current = _input(connection, version_id).compute_hash()
    return {"run": run_row, "findings": _findings(connection, run_row["id"]),
            "outdated": current != run_row["input_hash"]}


def decide(connection, payload, user=None):
    run_id, key, status = payload.get("run_id"), payload.get("finding_key"), payload.get("status")
    if status not in DECISIONS or not isinstance(key, str) or not isinstance(run_id, str):
        raise ValueError("Send run_id, finding_key and a status of open, accepted or rejected.")
    row = connection.execute(
        """UPDATE analysis_finding SET status=%s,
               decided_by=CASE WHEN %s = 'open' THEN NULL ELSE %s END,
               decided_at=CASE WHEN %s = 'open' THEN NULL ELSE now() END
           WHERE run_id=%s::uuid AND finding_key=%s
           RETURNING finding_key, status, decided_by, decided_at""",
        (status, status, user, status, run_id, key),
    ).fetchone()
    if not row:
        raise ValueError("The finding was not found.")
    return row
