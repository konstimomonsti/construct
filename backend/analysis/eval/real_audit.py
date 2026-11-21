"""Score source-first, position-level review cases on frozen repository bills."""

from collections import Counter, defaultdict
from hashlib import sha256
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .. import adapter
from ..layer1.spelling import default_checker
from ..runner import analyze
from . import EVAL_DIR
from .labels import guidance_kind, layers_that_ran, rule_matches


DEFAULT_MANIFEST = EVAL_DIR / "labels" / "repository_audit.json"
DEFAULT_SOURCE_DIR = Path("data/tenders")


class Case(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    file: str
    code: str | None
    locator: dict[str, str | int] = Field(min_length=1)
    verdict: Literal["error", "control", "unresolved"]
    rules: list[str] = Field(min_length=1)
    note: str = Field(min_length=1)
    evidence: dict[str, str | int] = Field(default_factory=dict)


class Manifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_id: Literal["billbuild.repository-audit.v1"] = Field(alias="schema")
    files: dict[str, str]
    cases: list[Case] = Field(min_length=1)


def _same_fields(actual, expected):
    return all(actual.get(key) == value for key, value in expected.items())


def score_case(case, snapshot, findings):
    lines = [line for line in snapshot.lines if line.code == case.code and _same_fields(line.source_locator, case.locator)]
    if len(lines) != 1:
        return "source_unlinked", []
    line = lines[0]
    matches = [finding for finding in findings
               if (finding.target.line_id == line.id or line.id in finding.related_line_ids)
               and rule_matches(case.rules, finding.rule_id) and _same_fields(finding.evidence, case.evidence)]
    if case.verdict == "unresolved":
        outcome = "unresolved"
    elif case.verdict == "control":
        outcome = "false_alarm" if matches else "clear_control"
    elif not matches:
        outcome = "missed"
    elif any(finding.target.line_id == line.id
             and _same_fields(finding.source_locator or {}, case.locator)
             and guidance_kind(finding) != "none" for finding in matches):
        outcome = "caught_with_guidance"
    else:
        outcome = "caught_needs_evidence"
    return outcome, sorted({finding.rule_id for finding in matches})


def audit(manifest_path=DEFAULT_MANIFEST, source_dir=DEFAULT_SOURCE_DIR):
    manifest = Manifest.model_validate_json(manifest_path.read_bytes())
    grouped = defaultdict(list)
    ids = set()
    for case in manifest.cases:
        if case.id in ids or case.file != Path(case.file).name or case.file not in manifest.files:
            raise ValueError(f"Invalid audit case {case.id!r}")
        ids.add(case.id)
        grouped[case.file].append(case)

    counts = Counter()
    outcomes = []
    for name, cases in grouped.items():
        data = (source_dir / name).read_bytes()
        if sha256(data).hexdigest() != manifest.files[name]:
            raise ValueError(f"Source fingerprint changed for {name}. Review its cases against the current source.")
        snapshot = adapter.from_bytes(name, data)
        result = analyze(snapshot, [1, 2])
        if result.errors or layers_that_ran(result, [1, 2]) != [1, 2]:
            raise ValueError(f"Assessment incomplete for {name}: {result.errors}")
        for case in cases:
            outcome, rules = score_case(case, snapshot, result.findings)
            counts[outcome] += 1
            outcomes.append({"id": case.id, "file": name, "code": case.code, "locator": case.locator,
                             "verdict": case.verdict, "outcome": outcome, "matched_rules": rules, "note": case.note})

    return {"files": len(grouped), "layers": [1, 2], "spelling_dictionary": default_checker().dictionary_name,
            "counts": dict(counts), "cases": outcomes}
