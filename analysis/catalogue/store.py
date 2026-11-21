"""PostgreSQL persistence for catalogue analytics."""

from __future__ import annotations

from collections import defaultdict
from uuid import UUID

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from analysis import units

from .rules import Product, SourceLine, attributes, code_key


class CatalogueError(ValueError):
    pass


class NotFound(CatalogueError):
    pass


class Conflict(CatalogueError):
    pass


def query(conn, sql, parameters=()):
    return conn.cursor(row_factory=dict_row).execute(sql, parameters)


def version(conn, bom_id):
    row = query(conn, "SELECT id, project_id FROM bom_version WHERE id = %s", (bom_id,)).fetchone()
    if row is None:
        raise NotFound(f"BOM version {bom_id} not found")
    return row


def lock_project(conn, project_id):
    conn.execute("SELECT lock_project(%s)", (project_id,))


def load_lines(conn, bom_id) -> list[SourceLine]:
    headers = {row["id"]: row for row in query(conn, """
        SELECT id, parent_section_id, display_code, title, scope_notes
        FROM bom_section WHERE bom_version_id = %s
    """, (bom_id,))}
    rows = query(conn, """
        SELECT l.*, bs.role, d.filename, d.format, d.sha256, si.id AS import_id, x.payload
        FROM bom_line l
        LEFT JOIN bom_source bs USING (bom_version_id, source_document_id)
        LEFT JOIN source_document d ON d.id = l.source_document_id
        LEFT JOIN source_import si ON si.source_document_id = d.id AND si.id::text = l.source_locator ->> 'import_id'
        LEFT JOIN source_extract x ON x.import_id = si.id AND x.ordinal = CASE
            WHEN l.source_locator ->> 'ordinal' ~ '^[0-9]{1,9}$' THEN (l.source_locator ->> 'ordinal')::int END
        WHERE l.bom_version_id = %s ORDER BY l.sort_order, l.id
    """, (bom_id,)).fetchall()
    source_notes = defaultdict(list)
    imports = list({row["import_id"] for row in rows if row["import_id"]})
    if imports:
        for note in query(conn, """
            SELECT import_id, ordinal, locator, payload FROM source_extract
            WHERE import_id = ANY(%s) AND kind = 'note' ORDER BY import_id, ordinal
        """, (imports,)):
            source_notes[note["import_id"]].append(note)
    evidence = defaultdict(set)
    for row in query(conn, """
        SELECT src.source_document_id, src.source_line_code, src.position_key
        FROM catalogue_source_line src JOIN bom_source bs USING (source_document_id)
        WHERE bs.bom_version_id = %s AND src.source_line_code IS NOT NULL
          AND src.source_kind IN ('item', 'item_candidate')
    """, (bom_id,)):
        evidence[row["source_document_id"], code_key(row["source_line_code"])].add(row["position_key"])

    companion_keys = {}
    primary = defaultdict(set)
    for row in rows:
        if not row["line_code"]:
            continue
        position = code_key(row["line_code"])
        known_keys = evidence[row["source_document_id"], position]
        key = next(iter(known_keys)) if len(known_keys) == 1 else None
        companion_keys[row["id"]] = key
        if row["role"] == "primary_scope":
            primary["position", position].add(row["source_document_id"])
            if key:
                primary["evidence", key].add(row["source_document_id"])

    result = []
    for row in rows:
        section_id, seen, notes = row["section_id"], set(), []
        while section_id in headers and section_id not in seen:
            seen.add(section_id)
            header = headers[section_id]
            notes.append({"section_id": str(section_id), "code": header["display_code"], "title": header["title"],
                          "notes": header["scope_notes"]})
            section_id = header["parent_section_id"]
        source_id = row["source_document_id"]
        companion_key = companion_keys.get(row["id"])
        duplicate = bool(row["line_code"] and row["role"] == "companion" and (
            primary["position", code_key(row["line_code"])] or
            (companion_key and primary["evidence", companion_key])
        ))
        # A BOM may include several primary sources. Reconcile equivalent complete
        # rows with reliable shared catalogue evidence, leaving separate positions intact.
        if companion_key and row["role"] == "primary_scope":
            sources = primary["evidence", companion_key]
            duplicate = len(sources) > 1 and source_id != min(sources)
        text = "\n".join(dict.fromkeys(filter(None, [row["short_description"], row["long_description"]])))
        payload = row["payload"] or {}
        notes.reverse()
        section_path = payload.get("section_path")
        ordinal = (row["source_locator"] or {}).get("ordinal")
        for note in source_notes[row["import_id"]] if isinstance(ordinal, int) else ():
            note_path = note["payload"].get("section_path")
            note_text = note["payload"].get("text")
            if not note_text or note["ordinal"] >= ordinal:
                continue
            if note_path and (not isinstance(section_path, str) or not (
                section_path == note_path or section_path.startswith(note_path + "/")
            )):
                continue
            notes.append({"section_id": str(row["section_id"]) if row["section_id"] else None, "title": "",
                          "notes": note_text, "locator": {**note["locator"], "ordinal": note["ordinal"],
                                                          "document_id": str(source_id)}})
        refs = tuple(ref["attributes"]["IDRef"] for ref in (payload.get("references") or [])
                     if ref["type"] == "RefRNo" and ref.get("attributes", {}).get("IDRef"))
        result.append(SourceLine(
            id=str(row["id"]), code=row["line_code"], section_id=str(row["section_id"]) if row["section_id"] else None,
            text=text, quantity=row["quantity"], unit=row["unit_code"], raw_unit=row["raw_unit"],
            total_rule=row["total_rule"], alternative_for=row["alternative_for_line_id"],
            pricing_basis=row["pricing_basis"],
            locator={**(row["source_locator"] or {}), "document_id": str(source_id) if source_id else None,
                     "filename": row["filename"], "format": row["format"], "sha256": row["sha256"]},
            section_notes=notes, source_role=row["role"], companion_key=companion_key,
            duplicate=duplicate, source_id=payload.get("source_id"), reference_ids=refs,
            headline=row["short_description"], raw_quantity=payload.get("quantity_raw", payload.get("quantity")),
        ))
    return result


def load_products(conn, project_id) -> list[Product]:
    aliases = defaultdict(list)
    for row in query(conn, """
        SELECT product_id, normalized_name FROM catalogue_product_alias WHERE project_id IS NULL OR project_id = %s
    """, (project_id,)):
        aliases[row["product_id"]].append(row["normalized_name"])
    sources = defaultdict(list)
    for row in query(conn, """
        SELECT product_id, d.filename, source_locator, position_key
        FROM catalogue_source_line s JOIN source_document d ON d.id = s.source_document_id
        WHERE product_id IS NOT NULL AND d.project_id = %s ORDER BY d.filename, position_key, source_locator
    """, (project_id,)):
        product_id = row.pop("product_id")
        if len(sources[product_id]) < 5:
            sources[product_id].append(row)
    products = []
    for row in query(conn, """
        SELECT p.id, p.name, p.description, p.supplier_sku, p.unit_code, s.name AS supplier,
               c.name AS catalogue_category, spec.category, spec.attributes, spec.provenance
        FROM product p JOIN product_category c ON c.id = p.category_id
        LEFT JOIN supplier s ON s.id = p.supplier_id
        LEFT JOIN catalogue_product_spec spec ON spec.product_id = p.id
        ORDER BY p.id
    """):
        category = row["category"] or row["catalogue_category"]
        extracted = attributes(row["name"] + "\n" + row["description"], category)
        for key, stored in (row["attributes"] or {}).items():
            observed = extracted.get(key)
            if observed is None or observed == stored:
                extracted[key] = stored
            elif stored is not None:
                extracted[key] = sorted(set([*observed, stored] if isinstance(observed, list) else [observed, stored]))
        products.append(Product(str(row["id"]), category, row["name"], row["description"], row["supplier"],
                                row["supplier_sku"], units.normalize(row["unit_code"]), extracted,
                                tuple(aliases[row["id"]]), tuple(filter(None, [row["provenance"], *sources[row["id"]]]))))
    return products


def get_resolution(conn, project_id, candidate):
    row = query(conn, """
        INSERT INTO catalogue_resolution (project_id, fingerprint, specification)
        VALUES (%s, %s, %s)
        ON CONFLICT (project_id, fingerprint) DO NOTHING RETURNING id
    """, (project_id, candidate.fingerprint, Jsonb(candidate.specification))).fetchone()
    if row is None:
        row = query(conn, """
            SELECT id FROM catalogue_resolution WHERE project_id = %s AND fingerprint = %s
        """, (project_id, candidate.fingerprint)).fetchone()
    return row["id"]


def current_decision(conn, resolution_id):
    return query(conn, """
        SELECT d.* FROM catalogue_decision d WHERE resolution_id = %s
        AND NOT EXISTS (SELECT FROM catalogue_decision newer
                        WHERE newer.resolution_id = d.resolution_id AND newer.previous_decision_id = d.id)
    """, (resolution_id,)).fetchone()


def current_attempt(conn, resolution_id):
    query(conn, """
        UPDATE catalogue_attempt SET status = 'uncertain', finished_at = clock_timestamp(),
            validation_error = 'Worker lease expired before the result was saved'
        WHERE resolution_id = %s AND status = 'running' AND lease_until <= clock_timestamp()
    """, (resolution_id,))
    return query(conn, """
        SELECT a.* FROM catalogue_attempt a WHERE resolution_id = %s
        AND NOT EXISTS (SELECT FROM catalogue_attempt newer
                        WHERE newer.resolution_id = a.resolution_id AND newer.previous_attempt_id = a.id)
    """, (resolution_id,)).fetchone()


def save_decision(conn, resolution_id, prior, *, outcome, state, method, evidence,
                  product=None, attempt_id=None, reviewer=None):
    if prior and all((
        prior["outcome"] == outcome, prior["state"] == state, prior["method"] == method,
        prior["product_identity"] == (product.identity if product else None),
        str(prior["product_id"]) == (product.id if product else "None"),
        prior["attempt_id"] == attempt_id, prior["evidence"] == evidence, prior["reviewer"] == reviewer,
    )):
        return prior
    return query(conn, """
        INSERT INTO catalogue_decision (resolution_id, previous_decision_id, attempt_id, outcome, state,
                                        method, product_id, product_identity, evidence, reviewer)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING *
    """, (resolution_id, prior["id"] if prior else None, attempt_id, outcome, state, method,
          product.id if product else None, product.identity if product else None, Jsonb(evidence), reviewer)).fetchone()


def save_occurrence(conn, bom_id, run_id, line_id, slot, resolution_id, candidate, reused, extraction_version):
    return query(conn, """
        INSERT INTO catalogue_occurrence (bom_version_id, run_id, bom_line_id, slot, resolution_id,
                                          extraction_version, candidate, reused)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (bom_line_id, slot) DO UPDATE SET
            run_id = excluded.run_id, decision_id = NULL, resolution_id = excluded.resolution_id,
            extraction_version = excluded.extraction_version, candidate = excluded.candidate,
            reused = excluded.reused, active = true
        RETURNING id
    """, (bom_id, run_id, line_id, slot, resolution_id, extraction_version, Jsonb(candidate.record()), reused)).fetchone()["id"]


def sync_occurrences(conn, resolution_id, decision):
    rows = query(conn, """
        SELECT * FROM catalogue_occurrence WHERE resolution_id = %s AND active
    """, (resolution_id,)).fetchall()
    for row in rows:
        candidate = row["candidate"]
        link = decision["product_id"] if (
            decision["state"] == "accepted"
            and candidate["scope"] in {"supplied", "installed", "separately_measured", "included_accessory"}
            and candidate["selection"] not in {"companion", "unreconciled_source"}
        ) else None
        material_id = sync_material(conn, row, link)
        query(conn, """
            UPDATE catalogue_occurrence SET decision_id = %s, material_item_id = %s
            WHERE id = %s AND (decision_id, material_item_id) IS DISTINCT FROM (%s::uuid, %s::uuid)
        """, (decision["id"], material_id, row["id"], decision["id"], material_id))


def sync_material(conn, row, product_id):
    candidate = row["candidate"]
    material_id = row["material_item_id"]
    # Existing quote protections remain authoritative. Idempotent or identification-only
    # work can still finish for a locked BOM.
    locked = query(conn, """
        SELECT EXISTS (
            SELECT FROM estimate e JOIN estimate_line el ON e.id = el.estimate_id
            JOIN bom_line bl ON bl.id = el.bom_line_id
            WHERE bl.bom_version_id = %s AND e.status = 'locked'
        ) AS locked
    """, (row["bom_version_id"],)).fetchone()["locked"]
    if locked:
        return material_id
    quantity = candidate["quantity"] if product_id is not None else None
    if material_id:
        query(conn, """
            UPDATE material_item SET product_id = %s, name = %s, quantity = %s::numeric, unit_code = %s
            WHERE id = %s AND (product_id, name, quantity, unit_code)
              IS DISTINCT FROM (%s::uuid, %s::text, %s::numeric, %s::text)
        """, (product_id, candidate["name"], quantity, candidate["unit"], material_id,
              product_id, candidate["name"], quantity, candidate["unit"]))
    elif product_id:
        material_id = query(conn, """
            INSERT INTO material_item (bom_line_id, product_id, name, quantity, unit_code)
            VALUES (%s, %s, %s, %s::numeric, %s) RETURNING id
        """, (row["bom_line_id"], product_id, candidate["name"], quantity, candidate["unit"])).fetchone()["id"]
    return material_id


def clear_obsolete(conn, bom_id, run_id):
    rows = query(conn, """
        UPDATE catalogue_occurrence SET active = false
        WHERE bom_version_id = %s AND run_id <> %s AND active RETURNING *
    """, (bom_id, run_id)).fetchall()
    for row in rows:
        sync_material(conn, row, None)


def as_uuid(value):
    try:
        return UUID(str(value))
    except (ValueError, TypeError) as exc:
        raise CatalogueError("Expected a UUID") from exc
