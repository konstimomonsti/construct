from hashlib import sha256
import json
from pathlib import Path

import pytest

from analysis.adapter import from_data
from analysis.eval.real_audit import Case, audit, score_case
from analysis.runner import analyze


def test_audit_requires_the_right_source_and_guidance_for_an_error():
    snapshot = from_data({"lines": [
        {"id": "a", "code": "1", "short_text": "Cutting", "unit": "m", "source_locator": {"row": 2}},
        {"id": "b", "code": "1", "short_text": "Filling", "unit": "m", "source_locator": {"row": 3}},
    ]})
    missing = [f for f in analyze(snapshot, [1]).findings if f.rule_id == "L1.QTY.MISSING"]
    case = Case(id="first", file="test.csv", code="1", locator={"row": 2}, verdict="error",
                rules=["L1.QTY.MISSING"], note="The first row has no quantity.")
    first = next(f for f in missing if f.target.line_id == "a")
    assert score_case(case, snapshot, missing)[0] == "caught_with_guidance"
    assert score_case(case, snapshot, [f for f in missing if f is not first])[0] == "missed"
    assert score_case(case, snapshot, [first.model_copy(update={"source_locator": {"row": 3}})])[0] == "caught_needs_evidence"
    assert score_case(case, snapshot, [first.model_copy(update={"suggested_fix": None})])[0] == "caught_needs_evidence"
    assert score_case(case.model_copy(update={"locator": {"row": 4}}), snapshot, missing)[0] == "source_unlinked"
    assert score_case(case.model_copy(update={"verdict": "control"}), snapshot, missing)[0] == "false_alarm"
    assert score_case(case.model_copy(update={"verdict": "unresolved"}), snapshot, missing)[0] == "unresolved"


def test_audit_rejects_replaced_source(tmp_path):
    source = tmp_path / "tender.X83"
    source.write_bytes(b"changed")
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({
        "schema": "billbuild.repository-audit.v1",
        "files": {source.name: sha256(b"original").hexdigest()},
        "cases": [{"id": "one", "file": source.name, "code": "1", "locator": {"source_id": "a"}, "verdict": "error",
                   "rules": ["L1.CODE.MISSING"], "note": "The position key is invalid."}],
    }))
    with pytest.raises(ValueError, match="Source fingerprint changed"):
        audit(manifest, tmp_path)


def test_repository_audit_scores_source_labels_without_assuming_unreviewed_positions_are_clean():
    tenders = Path(__file__).resolve().parents[3] / "data" / "tenders"
    result = audit(source_dir=tenders)
    assert result["files"] == 5 and result["layers"] == [1, 2]
    by_id = {case["id"]: case for case in result["cases"]}
    assert by_id["gaeb-award-damaged-oz"]["outcome"] == "caught_with_guidance"
    assert by_id["word-setup-duration"]["outcome"] == "caught_with_guidance"
    assert by_id["screed-included-edge-strip"]["outcome"] == "clear_control"
    assert by_id["word-alternative-code"]["outcome"] == "unresolved"
    assert "source_unlinked" not in result["counts"]
    assert sum(result["counts"].values()) == len(result["cases"]) == 11
