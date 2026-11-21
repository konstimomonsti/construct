"""Shared BillBuild workspace state, synced between browsers.

The frontend keeps its workspace in collections of records (folders, lists, edits, ...). Browsers send
record-level changes; each accepted change bumps one workspace revision so others can pull it.
"""

import json
import re

from psycopg.types.json import Jsonb

import workspace_analysis
import workspace_catalogue

WORKSPACE = "default"
COLLECTIONS = {
    "userFolders", "userLists", "userDocuments", "documentLinks", "documentFolders",
    "folderPatch", "listPatch", "edits", "stats", "calendar",
}
FILE_ID = re.compile(r"^[A-Za-z0-9_-]{1,120}$")
FILE_TYPES = {"application/pdf", "application/octet-stream"}
MAX_STATE_BYTES = 64 * 1024 * 1024
ASSESSMENT_PATCH_KEYS = {"cap", "capApproval", "derivedFrom", "correctedFrom", "awardDocumentId", "x86Doc", "phaseLink"}


def record_id(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 200:
        raise ValueError("Invalid record id.")
    return value


def _revision(connection):
    row = connection.execute("SELECT revision FROM workspace_sync WHERE workspace = %s", (WORKSPACE,)).fetchone()
    if row is None:
        raise ValueError("The shared workspace has not been initialised. Run the database migrations.")
    return row["revision"]


def state(connection, since=None):
    """The full workspace, or only its revision when the caller already has it."""
    revision = _revision(connection)
    if since is not None and since == revision:
        return {"revision": revision, "unchanged": True}
    collections = {name: {} for name in COLLECTIONS}
    for row in connection.execute(
        "SELECT collection, record_id, value FROM workspace_record WHERE workspace = %s", (WORKSPACE,)
    ):
        if row["collection"] in collections:
            collections[row["collection"]][row["record_id"]] = row["value"]
    return {"revision": revision, "collections": collections}


def _advance_revision(connection):
    row = connection.execute(
        "UPDATE workspace_sync SET revision = revision + 1, updated_at = now() WHERE workspace = %s "
        "RETURNING revision", (WORKSPACE,),
    ).fetchone()
    if row is None:
        raise ValueError("The shared workspace has not been initialised. Run the database migrations.")
    return row["revision"]


def _assessment_changes(connection, writes, deletes):
    collections = {"userLists", "edits", "listPatch", "userDocuments", "documentLinks"}
    changes = {key: None for key in deletes if key[0] in collections}
    changes.update({(collection, key): value for collection, key, value in writes if collection in collections})
    if not changes:
        return set(), set(), set()
    previous = {
        (row["collection"], row["record_id"]): row["value"] for row in connection.execute(
            """
            SELECT collection, record_id, value FROM workspace_record
            WHERE workspace=%s AND collection=ANY(%s) AND record_id=ANY(%s)
            """, (WORKSPACE, list(collections), sorted({key for _, key in changes})),
        )
    }
    lists, documents, packages = set(), set(), set()
    for (collection, key), value in changes.items():
        old = previous.get((collection, key))
        if collection == "listPatch":
            old = {field: old[field] for field in ASSESSMENT_PATCH_KEYS if isinstance(old, dict) and field in old}
            value = {field: value[field] for field in ASSESSMENT_PATCH_KEYS if isinstance(value, dict) and field in value}
        if old != value:
            (documents if collection in {"userDocuments", "documentLinks"} else lists).add(key)
            if collection == "userLists":
                for document in (old, value):
                    identity = document.get("phaseIdentity") if isinstance(document, dict) else None
                    if isinstance(identity, dict) and isinstance(identity.get("packageId"), str):
                        packages.add(identity["packageId"])
    return lists, documents, packages


def _related_phase_lists(connection, lists, packages):
    if not lists and not packages:
        return set()
    return {row["record_id"] for row in connection.execute(
        """
        SELECT record_id FROM workspace_record
        WHERE workspace=%s AND (
            (collection='listPatch' AND value->'phaseLink'->>'predecessorId'=ANY(%s))
            OR (collection='userLists' AND value->'phaseIdentity'->>'packageId'=ANY(%s))
        )
        """, (WORKSPACE, sorted(lists), sorted(packages)),
    )}


def apply(connection, payload):
    """Apply {collection: {"set": {id: value}, "delete": [id]}} atomically and return the new state."""
    changes = payload.get("changes")
    if not isinstance(changes, dict) or not set(changes) <= COLLECTIONS:
        raise ValueError("Invalid workspace changes.")
    writes, deletes = [], []
    for collection, change in changes.items():
        if not isinstance(change, dict):
            raise ValueError("Invalid workspace changes.")
        values = change.get("set", {})
        removed = change.get("delete", [])
        if not isinstance(values, dict) or not isinstance(removed, list):
            raise ValueError("Invalid workspace changes.")
        writes += [(collection, record_id(key), value) for key, value in values.items()]
        deletes += [(collection, record_id(key)) for key in removed]
    with connection.transaction():
        if writes or deletes:
            revision = _advance_revision(connection)
            assessment_lists, assessment_documents, packages = _assessment_changes(connection, writes, deletes)
            assessment_lists.update(workspace_analysis.original_lists(connection, WORKSPACE, assessment_documents))
            old_folders = ()
            if workspace_catalogue.configured_model():
                edited_lists = {key for collection, key, _ in writes if collection in {"userLists", "listPatch"}}
                edited_lists.update(key for collection, key in deletes if collection in {"userLists", "listPatch"})
                old_folders = workspace_catalogue.project_folders(connection, WORKSPACE, edited_lists)
            with connection.cursor() as cursor:
                if deletes:
                    cursor.executemany(
                        "DELETE FROM workspace_record WHERE workspace = %s AND collection = %s AND record_id = %s",
                        [(WORKSPACE, collection, key) for collection, key in deletes],
                    )
                if writes:
                    cursor.executemany(
                        """
                        INSERT INTO workspace_record (workspace, collection, record_id, value, revision)
                        VALUES (%s, %s, %s, %s, %s)
                        ON CONFLICT (workspace, collection, record_id)
                        DO UPDATE SET value = EXCLUDED.value, revision = EXCLUDED.revision, updated_at = now()
                        """,
                        [(WORKSPACE, collection, key, Jsonb(value, dumps=_dumps), revision)
                         for collection, key, value in writes],
                    )
            workspace_catalogue.workspace_changed(connection, WORKSPACE, writes, old_folders)
            assessment_lists.update(workspace_analysis.original_lists(connection, WORKSPACE, assessment_documents))
            assessment_lists.update(_related_phase_lists(connection, assessment_lists, packages))
            workspace_analysis.enqueue(connection, WORKSPACE, assessment_lists, revision=revision)
        return state(connection)


def _dumps(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def file_id(value):
    if not isinstance(value, str) or not FILE_ID.match(value):
        raise ValueError("Invalid file id.")
    return value


def save_file(connection, identifier, content_type, content):
    if content_type not in FILE_TYPES:
        content_type = "application/octet-stream"
    identifier = file_id(identifier)
    with connection.transaction():
        # Use the same lock order as metadata sync, including when the bytes arrive first.
        connection.execute("SELECT revision FROM workspace_sync WHERE workspace=%s FOR UPDATE", (WORKSPACE,))
        changed = connection.execute(
            """
            INSERT INTO workspace_file (workspace, file_id, content_type, content) VALUES (%s, %s, %s, %s)
            ON CONFLICT (workspace, file_id) DO UPDATE SET content_type=EXCLUDED.content_type, content=EXCLUDED.content
            WHERE (workspace_file.content_type, workspace_file.content) IS DISTINCT FROM (EXCLUDED.content_type, EXCLUDED.content)
            RETURNING file_id
            """, (WORKSPACE, identifier, content_type, content),
        ).fetchone()
        lists = workspace_analysis.original_lists(connection, WORKSPACE, {identifier}) if changed else set()
        if lists:
            workspace_analysis.enqueue(connection, WORKSPACE, lists, revision=_advance_revision(connection))
    return {"id": identifier, "bytes": len(content)}


def load_file(connection, identifier):
    row = connection.execute(
        "SELECT content_type, content FROM workspace_file WHERE workspace = %s AND file_id = %s",
        (WORKSPACE, file_id(identifier)),
    ).fetchone()
    if row is None:
        raise LookupError("File not found.")
    return row["content_type"], bytes(row["content"])


def delete_files(connection, payload):
    ids = payload.get("ids")
    if not isinstance(ids, list) or len(ids) > 1000:
        raise ValueError("Invalid file ids.")
    ids = [file_id(value) for value in ids]
    with connection.transaction():
        connection.execute("SELECT revision FROM workspace_sync WHERE workspace=%s FOR UPDATE", (WORKSPACE,))
        removed = connection.execute(
            "DELETE FROM workspace_file WHERE workspace=%s AND file_id=ANY(%s) RETURNING file_id", (WORKSPACE, ids)
        )
        lists = workspace_analysis.original_lists(connection, WORKSPACE, {row["file_id"] for row in removed})
        if lists:
            workspace_analysis.enqueue(connection, WORKSPACE, lists, revision=_advance_revision(connection))
    return {"deleted": len(ids)}
