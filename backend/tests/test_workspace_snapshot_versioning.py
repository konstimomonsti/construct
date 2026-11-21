"""Workspace snapshot regression tests. Database cases use an explicitly disposable cluster."""

import os
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
import pytest

import workspace
import workspace_analysis


def _list(filename=None):
    return {
        "fileName": filename,
        "source": {"kind": "gaeb-xml" if filename else "json"},
        "positions": [
            {"id": "p1", "oz": "01.0010", "qty": 10, "up": 5, "short": "Original 1",
             "path": [{"oz": "01", "label": "First"}]},
            {"id": "p2", "oz": "01.0020", "qty": 20, "up": 10, "short": "Original 2"},
        ],
    }


def test_apply_edits_add_remove_modify_and_move():
    edits = {
        "qty": {"p1": 15, "p3": 40},
        "up": {"p1": None},
        "patch": {"p1": {"short": "Updated 1", "oz": "02.0010"}},
        "removed": ["p2"],
        "added": [{"id": "p3", "oz": "02.0020", "qty": 1, "up": 20}],
        "moves": {"p1": "02"},
        "categories": {"added": [{"oz": "02", "parentOz": None, "label": "New"}],
                       "renamed": {"02": "Renamed"}},
    }
    positions = workspace_analysis._apply_edits(_list(), edits)["positions"]
    assert [p["id"] for p in positions] == ["p1", "p3"]
    assert positions[0]["qty"] == 15
    assert positions[0]["up"] is None
    assert positions[0]["oz"] == "02.0010"
    assert positions[0]["short"] == "Updated 1"
    assert positions[0]["path"] == [{"oz": "02", "label": "Renamed"}]
    assert positions[1]["qty"] == 40


@pytest.fixture
def database(monkeypatch):
    dsn = os.environ.get("BILLBUILD_DISPOSABLE_TEST_DSN")
    if not dsn:
        pytest.skip("Set BILLBUILD_DISPOSABLE_TEST_DSN to a migrated disposable database.")
    monkeypatch.setenv("ANALYSIS_L3_PROVIDER", "none")
    monkeypatch.setenv("BILLBUILD_CATALOGUE_MODEL", "none")
    name = "test-" + uuid4().hex
    monkeypatch.setattr(workspace, "WORKSPACE", name)
    with psycopg.connect(dsn, row_factory=dict_row, autocommit=True) as db:
        db.execute("INSERT INTO workspace_sync (workspace) VALUES (%s)", (name,))
        try:
            yield db, dsn, name
        finally:
            db.execute("DELETE FROM workspace_sync WHERE workspace=%s", (name,))


def _write(db, **collections):
    return workspace.apply(db, {"changes": {key: {"set": value} for key, value in collections.items()}})


def test_import_delayed_original_edits_caps_links_and_duplicate_delivery(database):
    db, _, name = database
    document = _list("sample.X83")
    _write(db, userLists={"list": document, "linked": document},
           userDocuments={"file": {"original": True, "listId": "list", "name": "sample.X83"}})
    while workspace_analysis.assess_next(db):
        pass
    previous = workspace_analysis.status(db, name, "list")
    assert previous["state"] == "partial"
    assert previous["report"]["source_notice"]
    revision = previous["report"]["target_revision"]

    workspace.save_file(db, "file", "application/octet-stream", b"<invalid/>")
    stale = workspace_analysis.status(db, name, "list")
    assert stale["state"] == "stale"
    assert stale["report"]["target_revision"] > revision
    file_revision = stale["report"]["target_revision"]
    workspace.save_file(db, "file", "application/octet-stream", b"<invalid/>")
    assert workspace_analysis.status(db, name, "list")["report"]["target_revision"] == file_revision

    edits = {"qty": {"p1": 2}, "removed": ["p2"]}
    _write(db, edits={"list": edits}, listPatch={"list": {"cap": 10}}, documentLinks={"file": "linked"})
    for list_id in ("list", "linked"):
        assert workspace_analysis.status(db, name, list_id)["outdated"]
    while workspace_analysis.assess_next(db):
        pass
    report = workspace_analysis.status(db, name, "list")["report"]
    assert report["assessed_edits"] == edits
    assert report["target_revision"] == report["assessed_revision"]

    _write(db, edits={"list": edits}, listPatch={"list": {"cap": 10, "findingDecisions": {}}})
    assert workspace_analysis.status(db, name, "list")["report"]["run_id"] == report["run_id"]
    workspace.apply(db, {"changes": {"edits": {"delete": ["list"]}}})
    assert workspace_analysis.status(db, name, "list")["state"] == "stale"


def test_rollback_superseded_claim_and_bounded_retries(database, monkeypatch):
    db, dsn, name = database
    with pytest.raises(RuntimeError):
        with db.transaction():
            _write(db, userLists={"list": _list()})
            raise RuntimeError("rollback")
    with pytest.raises(LookupError):
        workspace_analysis.status(db, name, "list")

    _write(db, userLists={"list": _list()})
    real_run = workspace_analysis.run

    def concurrent_edit(*args, **kwargs):
        with psycopg.connect(dsn, row_factory=dict_row, autocommit=True) as writer:
            _write(writer, edits={"list": {"qty": {"p1": 17}}})
        return real_run(*args, **kwargs)

    monkeypatch.setattr(workspace_analysis, "run", concurrent_edit)
    assert workspace_analysis.assess_next(db)
    assert workspace_analysis.status(db, name, "list")["state"] == "queued"
    monkeypatch.setattr(workspace_analysis, "run", real_run)
    assert workspace_analysis.assess_next(db)
    assert workspace_analysis.status(db, name, "list")["report"]["assessed_edits"] == {"qty": {"p1": 17}}

    def fail(*args, **kwargs):
        raise ValueError("synthetic failure")

    monkeypatch.setattr(workspace_analysis, "run", fail)
    _write(db, edits={"list": {"qty": {"p1": 18}}})
    for _ in range(workspace_analysis.MAX_RETRIES):
        assert workspace_analysis.assess_next(db)
    assert not workspace_analysis.assess_next(db)
    failed = workspace_analysis.status(db, name, "list")
    assert failed["state"] == "failed"
    assert failed["outdated"]


def test_expired_worker_cannot_overwrite_reclaimed_revision(database, monkeypatch):
    db, dsn, name = database
    _write(db, userLists={"list": _list()})
    real_run = workspace_analysis.run
    published = {}

    def reclaim(*args, **kwargs):
        with psycopg.connect(dsn, row_factory=dict_row, autocommit=True) as worker:
            worker.execute(
                "UPDATE workspace_assessment SET claimed_at=now() - interval '4 minutes' WHERE workspace=%s",
                (name,),
            )
            monkeypatch.setattr(workspace_analysis, "run", real_run)
            assert workspace_analysis.assess_next(worker)
            published.update(workspace_analysis.status(worker, name, "list")["report"])
        return real_run(*args, **kwargs)

    monkeypatch.setattr(workspace_analysis, "run", reclaim)
    assert workspace_analysis.assess_next(db)
    assert workspace_analysis.status(db, name, "list")["report"]["run_id"] == published["run_id"]


def test_confirmed_cap_and_explicit_phase_link_in_report(database):
    db, _, name = database
    offer = {**_list(), "phase": "X84", "currency": "EUR",
             "phaseIdentity": {"packageId": "north", "revision": "offer-1"}}
    offer["positions"] = [{**p, "positionKey": f"shared:{i}"} for i, p in enumerate(offer["positions"])]
    award = {**offer, "phase": "X86", "phaseIdentity": {"packageId": "north", "revision": "award-1"}}
    patch = {"phaseLink": {"predecessorId": "offer", "predecessorRevision": "offer-1", "revision": "award-1"},
             "capApproval": {"amount": "250.00", "currency": "EUR", "basis": "working_line_net",
                             "confirmationReference": "Cap-1"}}
    _write(db, userLists={"offer": offer, "award": award}, listPatch={"award": patch})
    while workspace_analysis.assess_next(db):
        pass
    report = workspace_analysis.status(db, name, "award")["report"]
    assert report["cap_comparison"]["state"] == "at"
    assert report["phase_validation"]["state"] == "verified"
    assert report["phase_validation"]["matched_positions"] == 2

    _write(db, userLists={"duplicate": award}, listPatch={"award": {**patch, "capApproval": None, "cap": 250}})
    while workspace_analysis.assess_next(db):
        pass
    report = workspace_analysis.status(db, name, "award")["report"]
    assert report["phase_validation"]["state"] == "invalid"
    assert report["cap_comparison"]["state"] == "unverified"
