"""Replay local tender uploads against a disposable, migrated database.

Read JSONL produced by frontend/tests/risk-upload-fixtures.ts on stdin.
Each fixture is rolled back after the worker runs. Layer 3 can run with local Ollama.
"""

import argparse
from collections import Counter
import json
import os
from pathlib import Path
import sys
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row

from analysis import adapter
from analysis.contracts import AnalysisResult
from analysis.runner import analyze
from . import harness, labels
import workspace
import workspace_analysis


GAEB_SUFFIXES = {".x83", ".d83", ".x84", ".d84", ".x86", ".d86"}
TABLE_SUFFIXES = {".csv", ".tsv", ".xlsx", ".json"}


def assess(connection, path, document, layers):
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
    if job["state"] != "ready" or report["errors"]:
        raise RuntimeError(f"{path.name}: assessment is incomplete: {report and report['errors']}")

    payload = workspace_analysis._uploaded_input(document)
    editable, _ = workspace_analysis.prepare(payload)
    canonical = editable
    if path.suffix.lower() in GAEB_SUFFIXES:
        if not report["used_source"]:
            raise RuntimeError(f"{path.name}: original GAEB file was not assessed")
        canonical = workspace_analysis._original_gaeb(editable, adapter.from_file(path), payload["original_refs"]).with_hash()
    result = AnalysisResult.model_validate({key: report[key] for key in AnalysisResult.model_fields if key in report})
    if result.input_hash != canonical.input_hash or labels.layers_that_ran(result, layers) != layers:
        raise RuntimeError(f"{path.name}: assessment used a different input or missed a requested layer")
    if layers == [1, 2] and result.findings != analyze(canonical, layers).findings:
        raise RuntimeError(f"{path.name}: stored upload findings disagree with its analysis input")

    row_ids = {position["id"] for position in document["positions"]}
    matched = sum(line.id in row_ids for line in canonical.lines)
    print(f"{path.name}\t{matched}/{len(canonical.lines)} positions linked\t{len(result.findings)} findings", file=sys.stderr)
    return {"findings": labels.compact(result, canonical)}


def score(reports, layers):
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
                if fresh:
                    print(f"{path.name}: unexpected {[finding['rule_id'] for finding in fresh]}", file=sys.stderr)
            elif not set(layers).intersection(label["layers"]):
                counts["layer_unrun"] += 1
            else:
                matched = [finding for finding in fresh if labels.finding_matches(label, finding)]
                counts["caught" if matched else "missed"] += 1
                if not matched:
                    print(f"{path.name}: missing {label['expect']} on {label['target']}", file=sys.stderr)
                if any(finding["guidance"] != "none" for finding in matched):
                    counts["guided"] += 1
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local-layer3", action="store_true", help="enable Layer 3 using Ollama on localhost")
    local = parser.parse_args().local_layer3
    os.environ["ANALYSIS_L3_PROVIDER"] = "ollama" if local else "none"
    if local:
        os.environ["OLLAMA_HOST"] = "http://127.0.0.1:11434"
    layers = [1, 2, 3] if local else [1, 2]
    workspace.WORKSPACE = f"eval-{uuid4().hex}"
    reports = {}
    with psycopg.connect("", autocommit=True, row_factory=dict_row, connect_timeout=3) as connection:
        if connection.execute("SELECT 1 FROM workspace_assessment WHERE state='queued' LIMIT 1").fetchone():
            raise RuntimeError("Use a disposable migrated database with an empty assessment queue.")
        with connection.transaction(force_rollback=True):
            connection.execute("INSERT INTO workspace_sync (workspace) VALUES (%s)", (workspace.WORKSPACE,))
            for entry in map(json.loads, sys.stdin):
                path = Path(entry["path"]).resolve()
                if path.suffix.lower() not in GAEB_SUFFIXES | TABLE_SUFFIXES:
                    raise ValueError(f"{path.name}: unsupported fixture format")
                reports[path] = assess(connection, path, entry["document"], layers)
    if not reports:
        raise ValueError("Supply at least one parsed upload on stdin.")
    counts = score(reports, layers)
    print(json.dumps({"uploads": len(reports), **counts}, sort_keys=True))
    return int(bool(counts["missed"] or counts["control_false_alarm"] or counts["caught"] != counts["guided"]))


if __name__ == "__main__":
    raise SystemExit(main())
