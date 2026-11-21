"""Labels (schema construct-eval-labels/1): what a correct analysis must report for a mutated file.

A label file `<mutated file>.labels.json` looks like

    {"schema": "construct-eval-labels/1", "file": "QTY-ZERO-01.X83", "suite": "catalogue",
     "baseline": "building_hall_clean.X83", "seed": {...}, "mutation": {...},
     "labels": [{"id": "QTY-ZERO-01/1", "mutation_type": "QTY-ZERO",
                 "target": {"line_codes": ["05.02.0040"]},
                 "expect": ["L1.QTY.ZERO"], "match": "line", "also_acceptable": [], "gap": false,
                 "control": false, "layers": [1], "note": ""}]}

Labels never contain finding ids: those are hashes of the file content and change with every mutation.
They name the OZ (`line_code`), the section code, or the trigger codes of a layer 2 check.

* `expect`: rule ids (fnmatch patterns allowed). A new finding of one of them on the target counts as caught.
* `match`: how the target is compared: `line` (finding's OZ in target.line_codes), `section`
  (finding's section code in target.section_codes), `dependency` (finding of a layer 2 rule whose trigger
  items share an OZ with target.trigger_codes), `bom` (a finding on the whole BoQ), `none` (controls).
* `also_acceptable`: rule ids that may appear as a consequence of the change; they are neither a catch nor a
  false alarm.
* `gap`: no rule detects this yet. Reported as gap; if a finding does match, it is counted as caught.
* `control`: nothing must be reported.
* `layers`: the layers of the expected rules, derived from `expect`. A label whose layers did not run is
  "not run", never "missed".
"""

from __future__ import annotations

import csv
from fnmatch import fnmatchcase
import io
import json
from pathlib import Path

from ..contracts import AnalysisResult, Finding
from ..runner import analyze

SCHEMA = "construct-eval-labels/1"
RUN_SCHEMA = "construct-eval-run/1"
VERDICTS = ("true_error", "false_alarm", "importer_artefact", "unsure")


def write_fixture_labels(path: Path, baseline: str, label: dict) -> None:
    path.with_suffix(path.suffix + ".labels.json").write_text(json.dumps({
        "schema": SCHEMA, "file": path.name, "suite": "catalogue",
        "backend": path.suffix[1:], "baseline": baseline, "labels": [label],
    }), encoding="utf-8")


def load(path: str | Path) -> dict:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if payload.get("schema") != SCHEMA:
        raise ValueError(f"{path}: expected schema {SCHEMA}, found {payload.get('schema')!r}")
    return payload


def rule_matches(patterns, rule_id: str) -> bool:
    return any(fnmatchcase(rule_id, pattern) for pattern in patterns)


def finding_matches(label: dict, finding: dict) -> bool:
    """Does a compact finding (see compact()) hit this label's target with one of the expected rules?"""
    if not rule_matches(label.get("expect", []), finding["rule_id"]):
        return False
    target = label.get("target", {})
    if target.get("severity") and finding.get("severity") != target["severity"]:
        return False
    locator = finding.get("source_locator") or {}
    if any(locator.get(key) != value for key, value in target.get("source_locator", {}).items()):
        return False
    mode = label.get("match")
    if mode == "line":
        return finding["line_code"] in target.get("line_codes", [])
    if mode == "section":
        return finding["section_code"] in target.get("section_codes", [])
    if mode == "dependency":
        wanted = set(target.get("trigger_codes", []))
        affected = set(finding["trigger_codes"]) | {finding.get("line_code")}
        return not wanted or bool(wanted & affected)
    if mode == "bom":
        return finding["scope"] == "bom"
    return False


# --------------------------------------------------------------------------- compact findings and runs


def guidance_kind(finding: Finding) -> str:
    fix = finding.suggested_fix
    if fix and fix.operations:
        return "patch"
    question = finding.evidence.get("bieterfrage_de")
    if isinstance(question, str) and question.strip():
        return "bidder_question"
    if fix and fix.rationale.strip():
        return "review"
    return "none"


def compact(result: AnalysisResult, analysis_input) -> list[dict]:
    """Findings reduced to what labels can refer to. No ids, no hashes."""
    sections = {section.id: section.code for section in analysis_input.sections}
    codes = {line.id: line.code for line in analysis_input.lines}
    rows = []
    for finding in result.findings:
        triggers = [item.get("code") for item in finding.evidence.get("trigger_items", [])]
        rows.append({
            "rule_id": finding.rule_id, "layer": finding.layer, "severity": finding.severity,
            "scope": finding.scope, "line_code": finding.target.line_code,
            "section_code": sections.get(finding.target.section_id), "field": finding.target.field,
            "trigger_codes": [code for code in triggers if code],
            "related_codes": [codes.get(line_id) for line_id in finding.related_line_ids if codes.get(line_id)],
            "title": finding.title, "message": finding.message[:300],
            "guidance": guidance_kind(finding),
            "source_locator": finding.source_locator,
        })
    return rows


def layers_that_ran(result: AnalysisResult, requested: list[int]) -> list[int]:
    """A layer counts as run when it is in layers_run and did not report that it could not work.
    Layer 3 without a model is in layers_run but reports 'layer 3: ...' in errors."""
    failed = {int(error[6]) for error in result.errors if error.startswith("layer ") and error[6:7].isdigit()
              and error[7:8] == ":"}
    if any(error.startswith("L3.") for error in result.errors):
        failed.add(3)
    return [layer for layer in requested if layer in result.layers_run and layer not in failed]


def run_file(path: Path, layers: list[int], *, verified_synthetic: bool = False) -> dict:
    if 3 in layers and not verified_synthetic:
        raise ValueError("Layer 3 evaluation requires a verified generated synthetic file")
    from .mutate import read_back
    backend = "x83" if path.suffix.lower() == ".x83" else "json"
    analysis_input = read_back(path, backend)
    result = analyze(analysis_input, layers)
    return {"schema": RUN_SCHEMA, "file": path.name, "layers_requested": layers,
            "layers_run": layers_that_ran(result, layers), "errors": result.errors,
            "findings": compact(result, analysis_input)}


# --------------------------------------------------------------------------- real-file label template


def template_rows(path: Path, layers: list[int], per_finding: bool = False) -> list[dict]:
    """Rows for analysis/eval/labels/real_findings.csv: one per (file, rule) group, or one per finding.

    Finding ids of a real file are stable, because they derive from the file's hash. `finding_id` "*" labels the
    whole group. The verdict column is for a person to fill in: true_error | false_alarm | importer_artefact |
    unsure.
    """
    if 3 in layers:
        raise ValueError("The real-file labelling command supports layers 1 and 2")
    from .. import adapter
    analysis_input = adapter.from_json(path) if path.suffix.lower() == ".json" else adapter.from_file(path)
    result = analyze(analysis_input, layers)
    codes = {line.id: line.code for line in analysis_input.lines}
    rows = []
    if per_finding:
        for finding in result.findings:
            if finding.severity not in {"warning", "error"}:
                continue
            rows.append({"file": path.name, "rule_id": finding.rule_id, "finding_id": finding.id, "verdict": "",
                         "note": f"{codes.get(finding.target.line_id) or ''} {finding.title}".strip()})
        return rows
    groups: dict[str, list] = {}
    for finding in result.findings:
        if finding.severity in {"warning", "error"}:
            groups.setdefault(finding.rule_id, []).append(finding)
    for rule_id, findings in sorted(groups.items()):
        first = findings[0]
        rows.append({"file": path.name, "rule_id": rule_id, "finding_id": "*", "verdict": "",
                     "note": f"{len(findings)} finding(s), e.g. {codes.get(first.target.line_id) or ''}: {first.title}"})
    return rows


def template_csv(rows: list[dict]) -> str:
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, ["file", "rule_id", "finding_id", "verdict", "note"], lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return buffer.getvalue()
