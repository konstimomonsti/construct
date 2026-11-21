"""Replay local GAEB uploads against a disposable, migrated database.

Read JSONL produced by frontend/tests/risk-upload-fixtures.ts on stdin.
Each fixture is rolled back after the worker runs. Only Layers 1 and 2 run.
"""

from collections import Counter
import json
import os
from pathlib import Path
import sys
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row

from analysis import adapter
from analysis.runner import analyze
from . import harness, labels
import workspace
import workspace_analysis


def assess(connection, path, document):
    with connection.transaction(force_rollback=True):
        workspace.save_file(connection, "source", "application/octet-stream", path.read_bytes())
        workspace.apply(connection, {"changes": {
            "userLists": {"set": {"bom": document}},
            "userDocuments": {"set": {"source": {"name": path.name, "original": True, "listId": "bom"}}},
        }})
        if not workspace_analysis.assess_next(connection):
            raise RuntimeError(f"{path.name}: assessment was never queued")
        job = workspace_analysis.status(connection, workspace.WORKSPACE, "bom")

    report = job["report"]
    if job["state"] != "ready" or not report["used_source"] or report["errors"]:
        raise RuntimeError(f"{path.name}: original assessment is incomplete")

    payload = workspace_analysis._uploaded_input(document)
    editable, _ = workspace_analysis.prepare(payload)
    canonical = workspace_analysis._original_gaeb(editable, adapter.from_file(path), payload["original_refs"]).with_hash()
    direct = analyze(canonical, [1, 2])
    if report["input_hash"] != direct.input_hash or report["findings"] != [
        finding.model_dump(mode="json") for finding in direct.findings
    ]:
        raise RuntimeError(f"{path.name}: upload and source assessments disagree")

    row_ids = {position["id"] for position in document["positions"]}
    matched = sum(line.id in row_ids for line in canonical.lines)
    print(f"{path.name}\t{matched}/{len(canonical.lines)} positions linked\t{len(direct.findings)} findings", file=sys.stderr)
    return {"findings": labels.compact(direct, canonical)}


def score(reports):
    counts = Counter()
    for path, report in reports.items():
        label_path = Path(str(path) + ".labels.json")
        if not label_path.exists():
            continue
        payload = labels.load(label_path)
        if payload["suite"] == "demo":
            continue
        baseline = (path.parent / payload["baseline"]).resolve()
        fresh = report["findings"] if path == baseline else harness.new_findings(reports[baseline], report)
        for label in payload["labels"]:
            if label.get("control"):
                counts["control_false_alarm" if fresh else "control_clean"] += 1
            elif not {1, 2}.intersection(label["layers"]):
                counts["layer_unrun"] += 1
            else:
                matched = [finding for finding in fresh if labels.finding_matches(label, finding)]
                counts["caught" if matched else "missed"] += 1
                if any(finding["guidance"] != "none" for finding in matched):
                    counts["guided"] += 1
    return counts


def main():
    os.environ["ANALYSIS_L3_PROVIDER"] = "none"
    workspace.WORKSPACE = f"eval-{uuid4().hex}"
    reports = {}
    with psycopg.connect("", autocommit=True, row_factory=dict_row, connect_timeout=3) as connection:
        if connection.execute("SELECT 1 FROM workspace_assessment WHERE state='queued' LIMIT 1").fetchone():
            raise RuntimeError("Use a disposable migrated database with an empty assessment queue.")
        with connection.transaction(force_rollback=True):
            connection.execute("INSERT INTO workspace_sync (workspace) VALUES (%s)", (workspace.WORKSPACE,))
            for entry in map(json.loads, sys.stdin):
                path = Path(entry["path"]).resolve()
                if path.suffix.lower() not in {".x83", ".d83", ".x84", ".d84", ".x86", ".d86"}:
                    raise ValueError(f"{path.name}: expected a GAEB tender, offer or award")
                reports[path] = assess(connection, path, entry["document"])
    if not reports:
        raise ValueError("Supply at least one parsed upload on stdin.")
    counts = score(reports)
    print(json.dumps({"uploads": len(reports), **counts}, sort_keys=True))
    return int(bool(counts["missed"] or counts["control_false_alarm"] or counts["caught"] != counts["guided"]))


if __name__ == "__main__":
    raise SystemExit(main())
