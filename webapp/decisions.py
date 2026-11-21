"""Reviewer decisions on findings (accept / dismiss, with a reason and note).

The webapp has no database, so decisions live in one JSON file per uploaded document:
``webapp/var/decisions/{sha256}.json``. Files are written atomically. The notes can contain
tender text, so ``webapp/var/`` is git-ignored.

``DecisionStore`` is the interface the API talks to. A PostgreSQL store (migration 010 with
``decision_reason`` and ``decision_note`` on ``analysis_finding``) can replace the JSON store
later without touching the endpoints.

A document key is ``{sha256}:{boq_index}``: one file can hold several BoQs (one per Excel sheet,
for example). Finding ids are stable for the same file (``uuid5`` of the file hash), so decisions
survive re-analysis of the same file. A decision whose finding no longer exists (other layers
selected, rules changed) is *orphaned*: it is kept and reported, never deleted.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import tempfile
import threading
from typing import Any

from analysis.contracts import Status

# Statuses a reviewer can set. OPEN means "undo": the decision is removed.
SETTABLE = (Status.ACCEPTED.value, Status.REJECTED.value, Status.OPEN.value)

DOC_KEY = re.compile(r"^(?P<sha>[0-9a-f]{64}):(?P<boq>\d{1,6})$")
MAX_TEXT = 2000


class InvalidDocKey(ValueError):
    pass


def split_doc_key(doc_key: str) -> tuple[str, str]:
    """Return (sha256, boq_index). Raises InvalidDocKey, which also keeps paths safe."""
    match = DOC_KEY.match(doc_key or "")
    if not match:
        raise InvalidDocKey("The document key must look like '<sha256>:<boq index>'.")
    return match["sha"], match["boq"]


def make_doc_key(sha: str, boq_index: int | None) -> str:
    return f"{sha}:{0 if boq_index is None else int(boq_index)}"


def make_decision(status: str, reason: str | None = None, note: str | None = None, *,
                  rule_id: str | None = None, line_code: str | None = None,
                  title: str | None = None) -> dict[str, Any]:
    """A decision record. ``rule_id``, ``line_code`` and ``title`` are kept so an orphaned
    decision can still be understood (and matched to a revised tender by OZ) later."""
    if status not in (Status.ACCEPTED.value, Status.REJECTED.value):
        raise ValueError(f"A decision must be accepted or rejected, not {status!r}.")
    return {
        "status": status,
        "reason": (reason or "").strip()[:MAX_TEXT] or None,
        "note": (note or "").strip()[:MAX_TEXT] or None,
        "decided_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "rule_id": rule_id, "line_code": line_code, "title": title,
    }


class DecisionStore(ABC):
    """Decisions per document key: ``{finding_id: decision}``."""

    @abstractmethod
    def get_all(self, doc_key: str) -> dict[str, dict[str, Any]]:
        """Every saved decision of one BoQ."""

    @abstractmethod
    def put_many(self, doc_key: str, decisions: dict[str, dict[str, Any] | None]) -> None:
        """Save decisions in one write. A value of None removes that finding's decision."""

    def put(self, doc_key: str, finding_id: str, decision: dict[str, Any] | None) -> None:
        self.put_many(doc_key, {finding_id: decision})


class JsonDecisionStore(DecisionStore):
    def __init__(self, root: Path | str):
        self.root = Path(root)
        self._lock = threading.Lock()

    def _path(self, sha: str) -> Path:
        return self.root / f"{sha}.json"

    def _read(self, sha: str) -> dict[str, Any]:
        path = self._path(sha)
        if not path.is_file():
            return {"version": 1, "sha256": sha, "boqs": {}}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            # A damaged file must not take the report down; keep it aside and start fresh.
            try:
                os.replace(path, path.with_suffix(".corrupt"))
            except OSError:
                pass
            return {"version": 1, "sha256": sha, "boqs": {}}
        data.setdefault("boqs", {})
        return data

    def get_all(self, doc_key: str) -> dict[str, dict[str, Any]]:
        sha, boq = split_doc_key(doc_key)
        with self._lock:
            return dict(self._read(sha)["boqs"].get(boq, {}))

    def put_many(self, doc_key: str, decisions: dict[str, dict[str, Any] | None]) -> None:
        sha, boq = split_doc_key(doc_key)
        if not decisions:
            return
        with self._lock:
            data = self._read(sha)
            current = data["boqs"].setdefault(boq, {})
            for finding_id, decision in decisions.items():
                if decision is None:
                    current.pop(finding_id, None)
                else:
                    current[finding_id] = decision
            if not current:
                data["boqs"].pop(boq, None)
            self._write(sha, data)

    def _write(self, sha: str, data: dict[str, Any]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        path = self._path(sha)
        if not data["boqs"]:
            path.unlink(missing_ok=True)
            return
        # Write a temp file in the same folder, then rename over the target: readers see the old
        # or the new file, never a half-written one.
        fd, tmp = tempfile.mkstemp(dir=self.root, prefix=f".{sha[:12]}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(data, handle, ensure_ascii=False, indent=1, sort_keys=True)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
