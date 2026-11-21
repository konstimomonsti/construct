from decimal import Decimal
from unittest.mock import MagicMock
import pytest

from workspace_analysis import (
    MAX_RETRIES, _apply_edits, assess_next, enqueue, status,
)


def test_apply_edits_add_remove_modify():
    """_apply_edits correctly reflects edits to positions."""
    doc = {
        "positions": [
            {"id": "p1", "oz": "01.01.0010", "qty": 10, "up": 5.0, "short": "Original 1"},
            {"id": "p2", "oz": "01.01.0020", "qty": 20, "up": 10.0, "short": "Original 2"},
            {"id": "p3", "oz": "01.01.0030", "qty": 30, "up": 15.0, "short": "Original 3"},
        ]
    }
    edits = {
        "setQty": {"p1": 15},
        "setUp": {"p1": 6.0},
        "patchPosition": {"p2": {"short": "Updated 2"}},
        "removePositions": ["p3"],
        "addPosition": [{"id": "p4", "oz": "01.01.0040", "qty": 40, "up": 20.0, "short": "Added 4"}],
    }
    effective = _apply_edits(doc, edits)
    p_map = {p["id"]: p for p in effective["positions"]}
    assert len(p_map) == 3
    assert "p3" not in p_map
    assert p_map["p1"]["qty"] == 15
    assert p_map["p1"]["up"] == 6.0
    assert p_map["p2"]["short"] == "Updated 2"
    assert p_map["p4"]["oz"] == "01.01.0040"


class MockConnection:
    """In-memory mock database connection to test versioning and worker lifecycle."""

    def __init__(self):
        self.workspace_sync = {"default": {"revision": 1}}
        self.workspace_record = {}  # (workspace, collection, record_id) -> value
        self.workspace_assessment = {}  # (workspace, list_id) -> dict
        self.queries = []

    def transaction(self):
        class Tx:
            def __enter__(self_inner):
                return self
            def __exit__(self_inner, exc_type, exc_val, exc_tb):
                pass
        return Tx()

    def execute(self, sql, params=None):
        self.queries.append((sql, params))
        sql_clean = " ".join(sql.split())

        if "SELECT revision FROM workspace_sync" in sql_clean:
            ws = params[0]
            rev = self.workspace_sync.get(ws, {}).get("revision", 1)
            return MockResult([{"revision": rev}])

        if "INSERT INTO workspace_assessment" in sql_clean:
            # params: (revision, workspace, [list_ids])
            rev, ws, list_ids = params
            for lid in list_ids:
                existing = self.workspace_assessment.get((ws, lid), {})
                self.workspace_assessment[(ws, lid)] = {
                    "workspace": ws,
                    "list_id": lid,
                    "revision": rev,
                    "assessed_revision": existing.get("assessed_revision"),
                    "state": "queued",
                    "retries": 0,
                    "claimed_at": None,
                    "report": existing.get("report"),
                }
            return MockResult([])

        if "SELECT a.state, a.report, a.revision AS target_revision" in sql_clean:
            ws, lid = params
            row = self.workspace_assessment.get((ws, lid))
            if row:
                row_copy = dict(row)
                row_copy["target_revision"] = row["revision"]
                return MockResult([row_copy])
            return MockResult([])

        if "SELECT sub.workspace, sub.list_id FROM workspace_assessment" in sql_clean or "SELECT a.workspace, a.list_id" in sql_clean:
            # Claim job
            for (ws, lid), item in self.workspace_assessment.items():
                if item["state"] == "queued":
                    item["state"] = "running"
                    return MockResult([{"workspace": ws, "list_id": lid, "revision": item["revision"], "retries": item["retries"]}])
            return MockResult([])

        if "SELECT value FROM workspace_record WHERE workspace=%s AND collection='userLists'" in sql_clean:
            ws, lid = params
            val = self.workspace_record.get((ws, "userLists", lid))
            return MockResult([{"value": val}] if val else [])

        if "SELECT value FROM workspace_record WHERE workspace=%s AND collection='edits'" in sql_clean:
            ws, lid = params
            val = self.workspace_record.get((ws, "edits", lid))
            return MockResult([{"value": val}] if val else [])

        if "SELECT value FROM workspace_record WHERE workspace=%s AND collection='listPatch'" in sql_clean:
            ws, lid = params
            val = self.workspace_record.get((ws, "listPatch", lid))
            return MockResult([{"value": val}] if val else [])

        if "SELECT revision, retries FROM workspace_assessment WHERE workspace=%s AND list_id=%s FOR UPDATE" in sql_clean:
            ws, lid = params
            row = self.workspace_assessment.get((ws, lid))
            return MockResult([{"revision": row["revision"], "retries": row["retries"]}] if row else [])

        if "UPDATE workspace_assessment SET state='ready'" in sql_clean:
            report, assessed_rev, ws, lid = params
            item = self.workspace_assessment[(ws, lid)]
            item["state"] = "ready"
            item["report"] = report
            item["assessed_revision"] = assessed_rev
            item["retries"] = 0
            item["claimed_at"] = None
            return MockResult([])

        if "UPDATE workspace_assessment SET state='queued'" in sql_clean:
            # Could be retry or superseded
            ws, lid = params[-2], params[-1]
            item = self.workspace_assessment[(ws, lid)]
            item["state"] = "queued"
            item["claimed_at"] = None
            return MockResult([])

        return MockResult([])


class MockResult:
    def __init__(self, rows):
        self._rows = rows

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


def test_enqueue_on_edits_and_caps():
    """Edits, cap changes, and link changes enqueue the assessment with the current revision."""
    conn = MockConnection()
    conn.workspace_sync["default"] = {"revision": 4}

    # Edit write
    writes = [("edits", "list_123", {"setQty": {"p1": 5}})]
    enqueue(conn, "default", writes, revision=4)

    assert ("default", "list_123") in conn.workspace_assessment
    assert conn.workspace_assessment[("default", "list_123")]["revision"] == 4
    assert conn.workspace_assessment[("default", "list_123")]["state"] == "queued"

    # Status before run is queued
    st = status(conn, "default", "list_123")
    assert st["state"] == "queued"


def test_coalescing_and_stale_status():
    """If an existing ready report exists, newer edits cause status to return stale."""
    conn = MockConnection()
    conn.workspace_assessment[("default", "list_1")] = {
        "workspace": "default",
        "list_id": "list_1",
        "revision": 2,
        "assessed_revision": 2,
        "state": "ready",
        "retries": 0,
        "claimed_at": None,
        "report": {"findings": [], "risk": {"score": 20}},
    }

    # Current status is ready
    st = status(conn, "default", "list_1")
    assert st["state"] == "ready"
    assert st["outdated"] is False

    # A new edit arrives at revision 3
    enqueue(conn, "default", [("edits", "list_1", {})], revision=3)
    assert conn.workspace_assessment[("default", "list_1")]["revision"] == 3

    # Status is now stale because assessed_revision (2) < target_revision (3)
    st = status(conn, "default", "list_1")
    assert st["state"] == "stale"
    assert st["outdated"] is True
    assert st["report"]["outdated"] is True
    assert st["report"]["assessed_revision"] == 2
    assert st["report"]["target_revision"] == 3


def test_older_run_does_not_overwrite_newer_revision():
    """A worker running against revision 2 does not overwrite when revision 3 arrived concurrently."""
    conn = MockConnection()
    conn.workspace_assessment[("default", "list_1")] = {
        "workspace": "default",
        "list_id": "list_1",
        "revision": 2,
        "assessed_revision": 1,
        "state": "queued",
        "retries": 0,
        "claimed_at": None,
        "report": None,
    }
    conn.workspace_record[("default", "userLists", "list_1")] = {
        "positions": [{"id": "p1", "oz": "01.01.0010", "qty": 1, "unit": "m", "short": "test"}],
        "source": {"kind": "json"},
    }

    # Simulate: user edits to revision 3 while worker claims revision 2
    # Claim job will claim rev 2
    # Then we bump DB revision to 3 before publish
    original_execute = conn.execute

    def intercept_execute(sql, params=None):
        if "UPDATE workspace_assessment a SET state='running'" in " ".join(sql.split()):
            res = original_execute(sql, params)
            # Concurrently, user pushes revision 3!
            conn.workspace_assessment[("default", "list_1")]["revision"] = 3
            return res
        return original_execute(sql, params)

    conn.execute = intercept_execute

    did_work = assess_next(conn)
    assert did_work is True
    # The job must remain queued for revision 3, not marked ready for revision 2!
    job = conn.workspace_assessment[("default", "list_1")]
    assert job["state"] == "queued"
    assert job["revision"] == 3
    assert job["assessed_revision"] == 1
