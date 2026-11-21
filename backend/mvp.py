import re
from decimal import Decimal, InvalidOperation
from pathlib import PurePosixPath
from uuid import UUID

from psycopg import sql
from psycopg.rows import dict_row, tuple_row

from analysis.units import is_known, normalize
from tender_import.common import detect_format
from tender_import.draft import create_draft
from tender_import.ingest import ingest


class Conflict(ValueError):
    pass


def identifier(value):
    try:
        return UUID(str(value))
    except ValueError as error:
        raise ValueError("Select a valid project, draft, or source document.") from error


def workspace(connection, project_id=None):
    projects = connection.execute("SELECT id, name FROM project ORDER BY name, id").fetchall()
    if not projects:
        return {"projects": [], "project": None, "drafts": [], "documents": []}
    selected = next((p for p in projects if p["id"] == project_id), None)
    if project_id and selected is None:
        raise ValueError("The project was not found.")
    selected = selected or next((p for p in projects if p["name"] == "Challenge A import review"), projects[0])
    drafts = connection.execute(
        """
        SELECT v.id, v.title, v.review_status, v.version_no, v.edit_revision, d.filename, d.id AS source_id,
               (SELECT count(*) FROM bom_line b WHERE b.bom_version_id=v.id) AS lines,
               (SELECT count(*) FROM bom_line b WHERE b.bom_version_id=v.id
                  AND b.draft_unit_price IS NOT NULL) AS priced
        FROM bom_version v
        LEFT JOIN LATERAL (
            SELECT d.id, d.filename FROM bom_source bs JOIN source_document d ON d.id = bs.source_document_id
            WHERE bs.bom_version_id=v.id AND bs.role='primary_scope' LIMIT 1
        ) d ON true
        WHERE v.project_id=%s ORDER BY v.title, v.version_no DESC
        """, (selected["id"],),
    ).fetchall()
    documents = connection.execute(
        """
        SELECT d.id, d.filename, d.format, d.exchange_phase, i.status, i.metadata->'counts' AS counts,
               jsonb_array_length(coalesce(i.metadata->'issues', '[]'::jsonb)) AS warnings,
               ARRAY(SELECT DISTINCT (e.payload->>'boq_index')::int FROM source_extract e
                     WHERE e.import_id=i.id AND e.kind='boq_header' ORDER BY 1) AS boq_indexes
        FROM source_document d
        JOIN LATERAL (
            SELECT id, status, metadata FROM source_import
            WHERE source_document_id=d.id ORDER BY imported_at DESC, id DESC LIMIT 1
        ) i ON true
        WHERE d.project_id = %s AND d.format <> 'zip' ORDER BY d.filename, d.id
        """, (selected["id"],),
    ).fetchall()
    return {"projects": projects, "project": selected, "drafts": drafts, "documents": documents}


def create_project(connection, payload):
    name = field_text(payload.get("name"), 160)
    if not name:
        raise ValueError("Enter a project name.")
    return connection.execute("INSERT INTO project (name) VALUES (%s) RETURNING id, name", (name,)).fetchone()


def upload(connection, project_id, filename, content):
    name = PurePosixPath(filename.replace("\\", "/")).name
    if not name or len(name) > 240 or not content:
        raise ValueError("Choose a nonempty file with a valid filename.")
    if detect_format(name, content) == "unsupported":
        raise ValueError("Choose PDF, Word (.docx), GAEB XML, legacy GAEB, or ZIP.")
    if not connection.execute("SELECT id FROM project WHERE id=%s", (project_id,)).fetchone():
        raise ValueError("The project was not found.")
    connection.row_factory = tuple_row
    try:
        # The importer commits source bytes before extraction, including when parsing fails.
        result = ingest(connection, project_id, name, content)
    finally:
        connection.row_factory = dict_row
    return {key: result[key] for key in ("document_id", "status", "filename", "format", "counts", "issues")}


def make_draft(connection, payload):
    document = identifier(payload.get("document_id"))
    index = payload.get("boq_index")
    if index is not None and (type(index) is not int or index < 1):
        raise ValueError("Select a bill of quantities in this file.")
    info = connection.execute("SELECT sha256 FROM source_document WHERE id=%s", (document,)).fetchone()
    if not info:
        raise ValueError("The source document was not found.")
    package = f"upload-{info['sha256'][:20]}-{index or 1}"
    connection.row_factory = tuple_row
    try:
        return create_draft(connection, document, package, None, index, None, allow_bid=True)
    finally:
        connection.row_factory = dict_row


def load_bom(connection, version_id):
    version = connection.execute(
        """
        SELECT v.*, p.name AS project_name, COALESCE(v.draft_currency, p.default_currency)::text AS currency,
               d.id AS source_id, d.filename, d.exchange_phase, d.format,
               EXISTS (SELECT FROM bom_line bl JOIN estimate_line el ON el.bom_line_id=bl.id
                       JOIN estimate e ON e.id=el.estimate_id
                       WHERE bl.bom_version_id=v.id AND e.status='locked') AS locked
        FROM bom_version v JOIN project p ON p.id=v.project_id
        LEFT JOIN LATERAL (
            SELECT d.id, d.filename, d.exchange_phase, d.format FROM bom_source s
            JOIN source_document d ON d.id=s.source_document_id
            WHERE s.bom_version_id=v.id AND s.role='primary_scope' LIMIT 1
        ) d ON true WHERE v.id=%s
        """, (version_id,),
    ).fetchone()
    if not version:
        raise ValueError("The BOM draft was not found.")
    lines = connection.execute(
        """
        SELECT l.*, s.title AS section, s.display_code AS section_code,
               d.filename AS source_filename, e.payload->>'quantity' AS source_quantity,
               COALESCE(e.payload->>'unit_price', e.payload->'price_records'->0->>'unit_price') AS source_unit_price,
               candidate.id AS catalogue_id, candidate.name AS catalogue_name,
               candidate.category AS catalogue_category, candidate.decision AS catalogue_decision
        FROM bom_line l
        LEFT JOIN bom_section s ON s.id=l.section_id
        LEFT JOIN source_document d ON d.id=l.source_document_id
        LEFT JOIN source_extract e ON e.import_id=(l.source_locator->>'import_id')::uuid
            AND e.ordinal=(l.source_locator->>'ordinal')::int
        LEFT JOIN LATERAL (
            SELECT p.id, p.name, pc.name AS category, cs.decision
            FROM catalogue_source_line cs
            JOIN source_document cd ON cd.id=cs.source_document_id AND cd.sha256=d.sha256
            LEFT JOIN product p ON p.id=cs.product_id
            LEFT JOIN product_category pc ON pc.id=p.category_id
            WHERE cs.source_locator = l.source_locator - ARRAY['import_id', 'ordinal']
              AND cs.source_kind = e.kind
            ORDER BY (cd.id=d.id) DESC, cs.product_id
            LIMIT 1
        ) candidate ON true
        WHERE l.bom_version_id=%s
        ORDER BY l.sort_order, l.id
        """, (version_id,),
    ).fetchall()
    sections = connection.execute(
        "SELECT * FROM bom_section WHERE bom_version_id=%s ORDER BY sort_order", (version_id,)
    ).fetchall()
    return {"version": version, "lines": lines, "sections": sections}


def catalogue_analytics(connection, version_id):
    lines = load_bom(connection, version_id)["lines"]
    groups = {}
    matched = 0
    for line in lines:
        product_id = line["catalogue_id"]
        if product_id is None:
            continue
        matched += 1
        unit = normalize(line["unit_code"])
        key = (product_id, unit, line["catalogue_decision"])
        group = groups.setdefault(key, {
            "product_id": product_id, "product": line["catalogue_name"],
            "category": line["catalogue_category"], "unit": unit,
            "scope": line["catalogue_decision"], "included_quantity": None,
            "unquantified_included": 0, "excluded_positions": 0, "positions": [],
        })
        group["positions"].append({"line_id": line["id"], "code": line["line_code"]})
        if line["total_rule"] != "include" or line["pricing_basis"] != "unit_rate":
            group["excluded_positions"] += 1
        elif line["quantity"] is None or not is_known(unit) or unit == "lump_sum":
            group["unquantified_included"] += 1
        else:
            group["included_quantity"] = (group["included_quantity"] or Decimal(0)) + line["quantity"]
    products = sorted(groups.values(), key=lambda row: (
        row["category"], row["product"], row["scope"], row["unit"] or "",
    ))
    return {"positions": len(lines), "matched_positions": matched, "groups": products}


def field_text(value, limit):
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > limit or "\x00" in value:
        raise ValueError(f"Enter text up to {limit:,} characters.")
    return value.strip() or None


def field_number(value):
    value = field_text(value, 35)
    if not value:
        return None
    if not re.fullmatch(r"[+-]?\d{1,16}(?:[.,]\d{1,8})?", value):
        raise ValueError("Enter a decimal number with up to 16 whole and 8 fractional digits.")
    try:
        return Decimal(value.replace(",", "."))
    except InvalidOperation as error:
        raise ValueError("Enter a valid decimal number.") from error


def save(connection, payload):
    version_id = identifier(payload.get("id"))
    changes = payload.get("lines")
    revision = payload.get("revision")
    if not isinstance(changes, list) or not 1 <= len(changes) <= 5000 or type(revision) is not int:
        raise ValueError("Select a draft and one or more changed lines.")
    text_fields = {"line_code": 80, "short_description": 8000, "long_description": 100_000, "unit_code": 40}
    decimals = {"quantity", "draft_unit_price"}
    choices = {"pricing_basis": {"unit_rate", "lump_sum"},
               "total_rule": {"include", "conditional", "unit_price_only"}}
    with connection.transaction():
        version = connection.execute("SELECT project_id FROM bom_version WHERE id=%s", (version_id,)).fetchone()
        if not version:
            raise ValueError("The BOM draft was not found.")
        connection.execute("SELECT lock_project(%s)", (version["project_id"],))
        version = connection.execute("SELECT edit_revision FROM bom_version WHERE id=%s FOR UPDATE",
                                     (version_id,)).fetchone()
        if not version or version["edit_revision"] != revision:
            raise Conflict("This draft changed in another window. Reload it to see the latest saved version.")
        seen = set()
        for row in changes:
            if not isinstance(row, dict):
                raise ValueError("Invalid draft line.")
            line_id = identifier(row.get("id"))
            if line_id in seen:
                raise ValueError("A position may be edited once per save.")
            seen.add(line_id)
            fields = {}
            for name, value in row.items():
                if name in text_fields:
                    fields[name] = field_text(value, text_fields[name])
                elif name in decimals:
                    fields[name] = field_number(value)
                elif name in choices and isinstance(value, str) and value in choices[name]:
                    fields[name] = value
                elif name != "id":
                    raise ValueError("Invalid field or value in the draft edit.")
            if not fields or ("short_description" in fields and not fields["short_description"]):
                raise ValueError("A draft edit must include changed fields and keep a line description.")
            assignments = sql.SQL(", ").join(sql.SQL("{}=%s").format(sql.Identifier(name)) for name in fields)
            updated = connection.execute(
                sql.SQL("UPDATE bom_line SET {} WHERE id=%s AND bom_version_id=%s").format(assignments),
                [*fields.values(), line_id, version_id],
            )
            if updated.rowcount != 1:
                raise ValueError("One of the selected rows no longer belongs to this draft.")
        connection.execute(
            "UPDATE bom_version SET edit_revision=edit_revision+1 WHERE id=%s", (version_id,)
        )
    return load_bom(connection, version_id)
