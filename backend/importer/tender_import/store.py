from collections import Counter
from hashlib import sha256
import json
from math import isfinite

from psycopg.types.json import Jsonb

from .common import PARSER_VERSION, Result


def json_safe(value):
    if isinstance(value, str):
        # PostgreSQL JSONB cannot materialize a NUL. Exact bytes are kept in source_file.
        return value.replace("\x00", "␀")
    if isinstance(value, dict):
        return {json_safe(key): json_safe(entry) for key, entry in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(entry) for entry in value]
    if isinstance(value, float) and not isfinite(value):
        return str(value)
    return value


def jsonb(value):
    return Jsonb(json_safe(value), dumps=lambda data: json.dumps(data, ensure_ascii=False, allow_nan=False))


def project_key(connection, name, key):
    with connection.transaction():
        if key is not None:
            found = connection.execute("SELECT id FROM project WHERE id = %s", (key,)).fetchone()
            if found is None:
                raise ValueError(f"Project {key} does not exist")
            return found[0]
        found = connection.execute("SELECT id FROM project WHERE name = %s LIMIT 2", (name,)).fetchall()
        if len(found) > 1:
            raise ValueError("More than one project has this name. Use --project-id.")
        if found:
            return found[0][0]
        return connection.execute("INSERT INTO project (name) VALUES (%s) RETURNING id", (name,)).fetchone()[0]


def store_upload(connection, project_id, name, content, document_format):
    checksum = sha256(content).hexdigest()
    with connection.transaction():
        doc = connection.execute(
            """
            INSERT INTO source_document (project_id, filename, storage_key, sha256, format, import_status)
            VALUES (%s, %s, %s, %s, %s, 'pending')
            ON CONFLICT (project_id, sha256) DO NOTHING RETURNING id
            """,
            (project_id, name, f"db:sha256:{checksum}", checksum, document_format),
        ).fetchone()
        if doc is None:
            doc = connection.execute(
                "SELECT id FROM source_document WHERE project_id = %s AND sha256 = %s",
                (project_id, checksum),
            ).fetchone()
        connection.execute(
            "INSERT INTO source_file (source_document_id, content) VALUES (%s, %s) ON CONFLICT DO NOTHING",
            (doc[0], content),
        )
    return doc[0], checksum


def find_import(connection, document_id, parser_version):
    return connection.execute(
        "SELECT id, status, metadata FROM source_import WHERE source_document_id = %s AND parser_version = %s",
        (document_id, parser_version),
    ).fetchone()


def summarize(import_id, document_id, checksum, name, status, metadata):
    return {
        "document_id": str(document_id), "import_id": str(import_id), "filename": name,
        "sha256": checksum, "format": metadata["format"], "status": status,
        "version": metadata.get("format_version"), "phase": metadata.get("phase"),
        "counts": metadata["counts"], "issues": len(metadata["issues"]),
        **({"failed_members": metadata["failed_members"]} if "failed_members" in metadata else {}),
        **({"review_members": metadata["review_members"]} if "review_members" in metadata else {}),
    }


def save_result(connection, document_id, checksum, name, result: Result, parser_version=PARSER_VERSION, *, failed=False):
    record_counts = Counter(record.kind for record in result.records)
    status = "failed" if failed else "review" if result.needs_review else "parsed"
    metadata = {
        **result.metadata, "format": result.format, "format_version": result.version,
        "phase": result.phase, "issues": result.issues, "counts": dict(record_counts),
    }
    with connection.transaction():
        # This row lock serializes concurrent attempts of the same previously saved upload.
        connection.execute("SELECT id FROM source_document WHERE id = %s FOR UPDATE", (document_id,))
        existing = find_import(connection, document_id, parser_version)
        if existing and existing[1] != "failed" and not existing[2].get("failed_members", 0):
            return summarize(existing[0], document_id, checksum, name, existing[1], existing[2])
        import_id = connection.execute(
            """
            INSERT INTO source_import (source_document_id, parser_version, status, metadata)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (source_document_id, parser_version) DO UPDATE
            SET status = EXCLUDED.status, imported_at = now(), metadata = EXCLUDED.metadata
            RETURNING id
            """, (document_id, parser_version, status, jsonb(metadata)),
        ).fetchone()[0]
        if existing:
            connection.execute("DELETE FROM source_extract WHERE import_id = %s", (import_id,))
        with connection.cursor() as cursor:
            cursor.executemany(
                "INSERT INTO source_extract (import_id, ordinal, kind, locator, payload) VALUES (%s, %s, %s, %s, %s)",
                ((import_id, i, record.kind, jsonb(record.locator), jsonb(record.payload))
                 for i, record in enumerate(result.records, 1)),
            )
        connection.execute(
            """
            UPDATE source_document SET format = %s, format_version = %s, exchange_phase = %s, import_status = %s
            WHERE id = %s
            """, (result.format, result.version, result.phase, status, document_id),
        )
    return summarize(import_id, document_id, checksum, name, status, metadata)


def report(connection, document_id):
    row = connection.execute(
        """
        SELECT i.id, d.id, d.filename, d.sha256, i.status, i.parser_version, i.metadata
        FROM source_import i JOIN source_document d ON d.id = i.source_document_id
        WHERE d.id = %s ORDER BY i.imported_at DESC, i.id DESC LIMIT 1
        """, (document_id,),
    ).fetchone()
    if row is None:
        raise ValueError(f"No import found for document {document_id}")
    import_id, doc_id, name, checksum, status, version, metadata = row
    return {**summarize(import_id, doc_id, checksum, name, status, metadata), "parser_version": version, "metadata": metadata}


def records(connection, import_id, kind, limit, after):
    return [
        {"ordinal": ordinal, "kind": row_kind, "locator": locator, "payload": payload}
        for ordinal, row_kind, locator, payload in connection.execute(
            """
            SELECT ordinal, kind, locator, payload FROM source_extract
            WHERE import_id = %s AND ordinal > %s AND (%s::text IS NULL OR kind = %s)
            ORDER BY ordinal LIMIT %s
            """, (import_id, after, kind, kind, limit),
        )
    ]


def original(connection, document_id) -> bytes:
    row = connection.execute("SELECT content FROM source_file WHERE source_document_id = %s", (document_id,)).fetchone()
    if row is None:
        raise ValueError(f"No original was found for document {document_id}")
    return row[0]
