"""Run the shared BoQ analysis and retain one report per uploaded list."""

from collections import defaultdict
import logging
import os
import re
from threading import Thread
import time

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from analysis import adapter
from analysis.runner import DEFAULT_LAYERS, analyze
from tender_import.common import detect_format
from workspace_parse import original_document
from workspace_product_evidence import add_to_snapshot


LOG = logging.getLogger(__name__)


def options():
    provider = os.environ.get("ANALYSIS_L3_PROVIDER", "none").strip().lower()
    return {"ai_available": provider in {"ollama", "anthropic"}, "default_layers": list(DEFAULT_LAYERS)}


def _code(code):
    return tuple(part.lstrip("0") or "0" for part in str(code or "").strip(".").split("."))


def _source(connection, workspace, list_id, file_id, filename):
    row = connection.execute(
        """
        SELECT f.content, d.value->>'name' AS name
        FROM workspace_file f JOIN workspace_record d
          ON (d.workspace, d.collection, d.record_id) = (f.workspace, 'userDocuments', f.file_id)
        LEFT JOIN workspace_record l
          ON (l.workspace, l.collection, l.record_id) = (d.workspace, 'documentLinks', d.record_id)
        WHERE f.workspace=%s AND d.value->>'original'='true'
          AND coalesce(l.value #>> '{}',d.value->>'listId')=%s
          AND (%s::text IS NULL OR f.file_id=%s)
          AND (%s::text IS NULL OR d.value->>'name'=%s)
        ORDER BY f.file_id
        LIMIT 1
        """, (workspace, list_id, file_id, file_id, filename, filename),
    ).fetchone()
    if not row:
        return None
    content, name = bytes(row["content"]), row["name"]
    kind = detect_format(name, content)
    if kind in {"pdf", "xls", "docx"}:
        return original_document(name, content)
    if kind not in {"gaeb_xml", "gaeb_1990"}:
        return None
    return adapter.from_bytes(name, content)


def _attach_source(snapshot, source, original_codes):
    by_code = defaultdict(list)
    for line in source.lines:
        by_code[_code(line.code)].append(line)
    # Use only unambiguous matches. Keep the file's stated amount only while its inputs agree
    # with the draft. Changing quantity or price replaces the draft amount with a calculation.
    pairs = []
    source_lines = source.line_by_id()
    for line in snapshot.lines:
        if line.id not in original_codes:
            continue
        match_by_id = source_lines.get(line.id)
        matches = [match_by_id] if match_by_id is not None else by_code.get(_code(original_codes[line.id]), [])
        if len(matches) != 1:
            continue
        match = matches[0]
        pairs.append((line, match))
    current_ids = {match.id: line.id for line, match in pairs}
    for line, match in pairs:
        line.gaeb_flags = match.gaeb_flags
        line.source_locator = match.source_locator
        if match.source_locator and source.project.source_document.format in {"xls", "pdf", "docx"}:
            # The editable table needs numeric placeholders. Analysis keeps missing source fields missing.
            if match.quantity is None and line.quantity == 0:
                line.quantity = None
            line.quantity_raw = match.quantity_raw
            if match.unit is None and not line.unit_raw:
                line.unit = None
        line.total_rule = match.total_rule
        line.alternative_for = current_ids.get(match.alternative_for)
        if match.pricing_basis == "lump_sum":
            line.pricing_basis = "lump_sum"
        if (match.source_amounts and line.source_amounts and line.quantity == match.quantity
                and line.source_amounts.unit_price == match.source_amounts.unit_price and line.unit == match.unit):
            line.source_amounts.line_amount = match.source_amounts.line_amount
        elif (source.project.source_document.format in {"xls", "pdf", "docx"} and match.source_amounts
                and line.quantity == match.quantity and line.unit == match.unit
                and (line.price.unit_price if line.price else None) == match.source_amounts.unit_price):
            line.source_amounts = match.source_amounts
    return bool(pairs)

def _unique_keys(objects, key_of):
    by_key = defaultdict(list)
    for obj in objects:
        if key := key_of(obj):
            by_key[key].append(obj.id)
    return {key: ids[0] for key, ids in by_key.items() if len(ids) == 1}


def _original_tender(uploaded, source, original_refs):
    """Analyze the complete tender and retain workspace IDs where a match is unambiguous."""
    def source_ref(line):
        return (line.source_locator.get("source_id") or line.source_locator.get("sequence", "")).strip()

    upload_refs = _unique_keys(uploaded.lines, lambda line: original_refs.get(line.id))
    upload_codes = _unique_keys(uploaded.lines, lambda line: _code(line.code) if line.code else None)
    file_refs = _unique_keys(source.lines, source_ref)
    file_codes = _unique_keys(source.lines, lambda line: _code(line.code) if line.code else None)
    line_ids = {key: key for key in source.line_by_id().keys() & uploaded.line_by_id().keys()}
    line_ids.update({file_refs[key]: upload_refs[key] for key in file_refs.keys() & upload_refs.keys()
                     if file_refs[key] not in line_ids and upload_refs[key] not in line_ids})
    matched_upload_ids = set(line_ids.values())
    for key in file_codes.keys() & upload_codes.keys():
        source_id, upload_id = file_codes[key], upload_codes[key]
        if source_id not in line_ids and upload_id not in matched_upload_ids:
            line_ids[source_id] = upload_id

    upload_sections = _unique_keys(uploaded.sections, lambda section: _code(section.id))
    file_sections = _unique_keys(source.sections, lambda section: _code(section.code) if section.code else None)
    section_ids = {file_sections[key]: upload_sections[key] for key in file_sections.keys() & upload_sections.keys()}
    for section in source.sections:
        section.id = section_ids.get(section.id, section.id)
        section.parent_id = section_ids.get(section.parent_id, section.parent_id)
    for line in source.lines:
        line.id = line_ids.get(line.id, line.id)
        line.section_id = section_ids.get(line.section_id, line.section_id)
        line.alternative_for = line_ids.get(line.alternative_for, line.alternative_for)
    return source


def prepare(payload):
    layers = payload.get("layers", list(DEFAULT_LAYERS))
    if (not isinstance(layers, list) or not layers
            or any(type(layer) is not int or layer not in {1, 2, 3} for layer in layers)):
        raise ValueError("Choose analysis layers from 1, 2 and 3.")
    if 3 in layers and not options()["ai_available"]:
        raise ValueError("Layer 3 requires a configured AI provider.")
    data = payload.get("snapshot")
    if (not isinstance(data, dict) or not isinstance(data.get("lines"), list) or not data["lines"]
            or not isinstance(data.get("sections"), list)):
        raise ValueError("Choose a list with positions to assess.")
    for line in data["lines"]:
        if not isinstance(line, dict):
            raise ValueError("Each position must be an object.")
    seen = set()
    for section in data["sections"]:
        if (not isinstance(section, dict) or not isinstance(section.get("id"), str)
                or (section.get("parent_id") is not None and section["parent_id"] not in seen)):
            raise ValueError("The list has an invalid category hierarchy.")
        seen.add(section["id"])
    try:
        snapshot = adapter.from_data(data)
    except (AttributeError, KeyError, TypeError, ValueError) as error:
        raise ValueError("The list contains invalid assessment data.") from error
    return snapshot, layers


def run(payload, connection=None, workspace=None, list_id=None, file_id=None, filename=None, *, original_upload=False):
    snapshot, layers = prepare(payload)
    used_source = False
    source_notice = None
    if (file_id or filename) and connection is not None:
        try:
            source = _source(connection, workspace, list_id, file_id, filename)
        except (LookupError, ValueError, SyntaxError):
            source = None
            source_notice = "The original tender file could not be checked. Findings are based on the editable list."
        if source and source.lines:
            kind = source.project.source_document.format
            native_preview = kind in {"pdf", "docx", "xls"} and source.line_by_id().keys() & snapshot.line_by_id().keys()
            if original_upload and (native_preview or kind in {"gaeb_xml", "gaeb_1990"}):
                snapshot = _original_tender(snapshot, source, payload.get("original_refs", {}))
                used_source = True
            else:
                original_codes = payload.get("original_codes")
                if isinstance(original_codes, dict):
                    used_source = _attach_source(snapshot, source, original_codes)
                if used_source and source.project.source_document.format in {"xls", "pdf", "docx"}:
                    snapshot.import_warnings = source.import_warnings
            snapshot = snapshot.with_hash()
    evidence_files = add_to_snapshot(connection, workspace, list_id, snapshot) if connection is not None and list_id else []
    if evidence_files:
        snapshot = snapshot.with_hash()
    try:
        result = analyze(snapshot, layers)
    except Exception:
        if 3 not in layers:
            raise
        # Layer 3 handles provider failures itself; this is the last line of defence, so an unexpected
        # crash there still leaves the reviewer with the layer 1 and 2 findings.
        LOG.exception("Layer 3 failed; storing the layer 1 and 2 findings only")
        result = analyze(snapshot, [layer for layer in layers if layer != 3])
        result.errors.append("layer 3: failed unexpectedly; findings are from layers 1 and 2 only")
    return {**result.model_dump(mode="json"), "used_source": used_source, "source_notice": source_notice,
            "product_evidence_files": evidence_files}


def _source_decimal_text(value):
    if not isinstance(value, str):
        return None
    return re.sub(r"\s*(?:€|EUR)$", "", value, flags=re.I).replace("−", "-").strip() or None



def _uploaded_input(document):
    phase_match = re.fullmatch(r"[XD]?(8[1-6])", str(document.get("phase") or ""), re.I)
    phase = phase_match[1] if phase_match else None
    currency = document.get("currency")
    bid = phase in {"84", "86"}
    kind = document["source"]["kind"]
    sections = {}

    def add_section(code, label, parent_id):
        sections.setdefault(code, {"id": code, "parent_id": parent_id, "title": label,
                                   "code_parts": code.split(".") if phase else []})

    def visit(nodes, parent_id=None):
        for node in nodes:
            add_section(node["oz"], node.get("label"), parent_id)
            visit(node.get("children") or [], node["oz"])

    visit(document.get("tree") or [])
    lines = []
    original_codes = {}
    original_refs = {}
    for position in document["positions"]:
        section_id = None
        for part in position.get("path") or []:
            add_section(part["oz"], part.get("label"), section_id)
            section_id = part["oz"]
        cells = position.get("sourceCells")
        if kind not in {"csv", "xlsx", "json", "docx", "pdf"} or not isinstance(cells, dict):
            cells = None
        unit = cells.get("unit") if cells is not None else position.get("unit")
        short = position.get("short")
        line = {
            "id": position["id"],
            "code": position.get("oz") or None,
            "section_id": section_id,
            "short_text": short if short != "(ohne Kurztext)" else None,
            "long_text": position.get("long"),
            "quantity": position.get("qty"),
            "unit": unit,
            "pricing_basis": "lump_sum" if position.get("lumpSum") or (unit or "").lower().rstrip(".") == "psch" else "unit_rate",
        }
        if cells is not None:
            if "code" in cells:
                line["code"] = cells["code"] or None
            quantity = cells.get("quantity")
            line["quantity"] = _source_decimal_text(quantity)
            line["quantity_raw"] = quantity or None
            locator = {key: cells[key] for key in ("sheet", "row") if cells.get(key)}
            if locator:
                line["source_locator"] = locator
            price, amount = (_source_decimal_text(cells.get(key)) for key in ("unitPrice", "amount"))
            if price is not None or amount is not None:
                line["source_amounts"] = {"unit_price": price, "line_amount": amount}
        elif bid:
            line["source_amounts"] = {"unit_price": position.get("up")}
        elif position.get("up") is not None:
            line["price"] = {"unit_price": position["up"], "currency": currency, "source": "client"}
        if line["code"]:
            original_codes[line["id"]] = line["code"]
        if isinstance(position.get("srcRef"), str):
            original_refs[line["id"]] = position["srcRef"].strip()
        lines.append(line)
    return {
        "snapshot": {
            "project": {"currency": currency, "gaeb_phase": phase,
                        "source_document": {"filename": document.get("fileName"), "format": kind}},
            "bom": {"title": document.get("title")},
            "sections": list(sections.values()),
            "lines": lines,
        },
        "original_codes": original_codes,
        "original_refs": original_refs,
        "layers": [*DEFAULT_LAYERS, 3] if options()["ai_available"] else list(DEFAULT_LAYERS),
    }


def requeue_product_evidence(connection, workspace, list_ids):
    if list_ids:
        connection.execute(
            "UPDATE workspace_assessment SET state='queued', report=NULL WHERE workspace=%s AND list_id=ANY(%s)",
            (workspace, list(list_ids)),
        )


def enqueue(connection, workspace, writes, evidence_lists=()):
    list_ids = {key for collection, key, _ in writes if collection == "userLists"}
    list_ids.update(value["listId"] for collection, _, value in writes
                    if collection == "userDocuments" and isinstance(value, dict) and value.get("original") is True
                    and isinstance(value.get("listId"), str))
    list_ids.update(evidence_lists)
    if not list_ids:
        return
    connection.execute(
        """
        INSERT INTO workspace_assessment (workspace, list_id)
        SELECT lists.workspace, lists.record_id FROM workspace_record lists
        WHERE lists.workspace=%s AND lists.collection='userLists' AND lists.record_id=ANY(%s)
          AND lists.value->'source'->>'kind' IN ('gaeb-xml', 'gaeb90', 'pdf', 'docx', 'csv', 'xlsx', 'json')
          AND CASE WHEN jsonb_typeof(lists.value->'positions') = 'array'
              THEN jsonb_array_length(lists.value->'positions') > 0 ELSE false END
          AND EXISTS (
              SELECT 1 FROM workspace_record doc
              WHERE doc.workspace=lists.workspace AND doc.collection='userDocuments'
                AND doc.value->>'original'='true' AND doc.value->>'listId'=lists.record_id
                AND doc.value->>'name'=lists.value->>'fileName'
          )
        ON CONFLICT (workspace, list_id) DO NOTHING
        """, (workspace, list(list_ids)),
    )
    requeue_product_evidence(connection, workspace, evidence_lists)


def status(connection, workspace, list_id):
    result = connection.execute(
        "SELECT state, report FROM workspace_assessment WHERE workspace=%s AND list_id=%s",
        (workspace, list_id),
    ).fetchone()
    if not result:
        raise LookupError("Upload assessment not found.")
    return result


def assess_next(connection):
    with connection.transaction():
        # Claim the job without holding its row lock during analysis. A concurrent evidence
        # update can requeue it, changing its version and invalidating this worker's result.
        job = connection.execute(
            """
            WITH claimed AS MATERIALIZED (
                SELECT workspace, list_id
                FROM workspace_assessment
                WHERE state='queued'
                  AND pg_try_advisory_xact_lock(hashtextextended(workspace || chr(31) || list_id, 1685013603))
                LIMIT 1
            )
            SELECT a.workspace, a.list_id, a.xmin::text AS generation, d.value
            FROM claimed c
            JOIN workspace_assessment a USING (workspace, list_id)
            JOIN workspace_record d ON (d.workspace, d.collection, d.record_id)=(a.workspace, 'userLists', a.list_id)
            """,
        ).fetchone()
        if not job:
            return False
        workspace, list_id, document = job["workspace"], job["list_id"], job["value"]
        try:
            with connection.transaction():
                filename = document.get("fileName") if document["source"]["kind"] in {"gaeb-xml", "gaeb90", "pdf", "docx", "xlsx"} else None
                report = run(_uploaded_input(document), connection, workspace, list_id, filename=filename, original_upload=True)
        except psycopg.OperationalError:
            raise
        except Exception:
            LOG.exception("Could not assess an uploaded list")
            state, report = "failed", None
        else:
            state, report = "ready", Jsonb(report)
        connection.execute(
            "UPDATE workspace_assessment SET state=%s, report=%s WHERE workspace=%s AND list_id=%s AND xmin::text=%s",
            (state, report, workspace, list_id, job["generation"]),
        )
        return True


def _work():
    while True:
        try:
            with psycopg.connect("", autocommit=True, row_factory=dict_row, connect_timeout=4,
                                 options="-c statement_timeout=30000") as connection:
                while True:
                    if not assess_next(connection):
                        time.sleep(1)
        except psycopg.Error as error:
            LOG.warning("Upload assessment worker waiting for the database (%s)", type(error).__name__)
            time.sleep(4)


def start_worker():
    Thread(target=_work, name="upload-assessment", daemon=True).start()
