"""Run the analysis on the mutated files and score the result against the labels.

`run` writes one result file per mutated file (and per baseline) under `<out>/results/`. `report` reads the
labels and the results and never runs the analysis itself, so a slow layer 3 run is done once.

Scoring a file: the findings of its baseline (the clean seed in the same format) are subtracted first, so only
findings caused by the mutation count. Each remaining finding is then
  * a catch, if a label expects it on its target;
  * acceptable, if its rule is listed in `also_acceptable` of a label of that file;
  * a false alarm, otherwise (on a control file that is every new finding).
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
import json
from pathlib import Path

from . import labels as label_io

DEFAULT_LAYERS = [1, 2]


def label_files(out_dir: Path) -> list[Path]:
    return sorted(out_dir.rglob("*.labels.json"))


def result_path(out_dir: Path, mutated: Path) -> Path:
    relative = mutated.resolve().relative_to(out_dir.resolve()).as_posix().replace("/", "__")
    return out_dir / "results" / f"{relative}.json"


def run_all(out_dir: Path, layers: list[int], only_controls: bool = False, progress=None) -> list[Path]:
    """Analyse every labelled file and its baseline. Returns the result files written."""
    written: list[Path] = []
    done: set[Path] = set()
    for labels_path in label_files(out_dir):
        payload = label_io.load(labels_path)
        if only_controls and not all(entry.get("control") for entry in payload["labels"]):
            continue
        mutated = labels_path.with_name(payload["file"])
        for path in (mutated, (labels_path.parent / payload["baseline"]).resolve()):
            if path in done:
                continue
            done.add(path)
            target = result_path(out_dir, path)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(label_io.run_file(path, layers), indent=1, ensure_ascii=False) + "\n",
                              encoding="utf-8", newline="\n")
            written.append(target)
            if progress:
                progress(path)
    return written


def load_result(out_dir: Path, mutated: Path) -> dict:
    path = result_path(out_dir, mutated)
    if not path.exists():
        raise FileNotFoundError(f"No result for {mutated.name}. Run `python -m analysis.eval run` first.")
    return json.loads(path.read_text(encoding="utf-8"))


def _key(finding: dict) -> tuple:
    return (finding["rule_id"], finding["line_code"], finding["section_code"], finding["field"])


def new_findings(baseline: dict, result: dict) -> list[dict]:
    """Findings of the mutated file that the baseline does not have (compared as a multiset on rule and target)."""
    remaining = Counter(_key(f) for f in baseline["findings"])
    fresh = []
    for finding in result["findings"]:
        key = _key(finding)
        if remaining[key] > 0:
            remaining[key] -= 1
        else:
            fresh.append(finding)
    return fresh


# --------------------------------------------------------------------------- scoring


@dataclass
class LabelOutcome:
    file: str
    suite: str
    backend: str
    label: dict
    outcome: str  # caught | missed | gap | not_run | clean | false_alarm
    matched: list[dict] = field(default_factory=list)


@dataclass
class Evaluation:
    outcomes: list[LabelOutcome] = field(default_factory=list)
    false_alarms: list[tuple[str, dict]] = field(default_factory=list)  # (file, finding)
    per_rule: dict[str, Counter] = field(default_factory=lambda: defaultdict(Counter))
    layers_requested: list[int] = field(default_factory=list)
    layers_not_run: set[int] = field(default_factory=set)
    baseline_findings: dict[str, int] = field(default_factory=dict)
    files: int = 0


def evaluate(out_dir: Path, controls_only: bool = False, backend: str | None = None) -> Evaluation:
    evaluation = Evaluation()
    for labels_path in label_files(out_dir):
        payload = label_io.load(labels_path)
        if controls_only and not all(entry.get("control") for entry in payload["labels"]):
            continue
        if backend and payload["backend"] != backend:
            continue
        mutated = labels_path.with_name(payload["file"])
        baseline_path = (labels_path.parent / payload["baseline"]).resolve()
        result, baseline = load_result(out_dir, mutated), load_result(out_dir, baseline_path)
        evaluation.files += 1
        evaluation.layers_requested = sorted(set(evaluation.layers_requested) | set(result["layers_requested"]))
        evaluation.layers_not_run |= set(result["layers_requested"]) - set(result["layers_run"])
        if payload["mutation"]["type"] == "CTRL-CLEAN":
            evaluation.baseline_findings[mutated.name] = len(result["findings"])
        fresh = new_findings(baseline, result) if mutated.resolve() != baseline_path else list(result["findings"])
        suite = payload["suite"]

        explained: set[int] = set()
        for entry in payload["labels"]:
            matched = [f for f in fresh if label_io.finding_matches(entry, f)]
            explained |= {id(f) for f in matched}
            if entry.get("control"):
                outcome = "clean"  # decided below, after all labels of the file are known
            elif matched:
                outcome = "caught"
            elif entry["layers"] and not set(entry["layers"]) & set(result["layers_run"]):
                outcome = "not_run"
            elif entry.get("gap"):
                outcome = "gap"
            else:
                outcome = "missed"
            evaluation.outcomes.append(LabelOutcome(mutated.name, suite, payload["backend"], entry, outcome, matched))
            for finding in matched:
                if suite != "demo":
                    evaluation.per_rule[finding["rule_id"]]["tp"] += 1

        acceptable = [pattern for entry in payload["labels"] for pattern in entry.get("also_acceptable", [])]
        stray = []
        for finding in fresh:
            if id(finding) in explained:
                continue
            if label_io.rule_matches(acceptable, finding["rule_id"]):
                if suite != "demo":
                    evaluation.per_rule[finding["rule_id"]]["acceptable"] += 1
            else:
                if suite != "demo":
                    evaluation.per_rule[finding["rule_id"]]["fp"] += 1
                evaluation.false_alarms.append((mutated.name, finding))
                stray.append(finding)
        if stray:
            for outcome in evaluation.outcomes[-len(payload["labels"]):]:
                if outcome.outcome == "clean":
                    outcome.outcome = "false_alarm"
                    outcome.matched = stray
    return evaluation
