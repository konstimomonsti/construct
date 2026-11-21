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
from analysis.contracts import SourceDocument
from analysis.runner import DEFAULT_LAYERS, analyze
from tender_import.common import detect_format
from tender_import.legacy import gaeb_1990
from tender_import.structured import gaeb_xml
from workspace_parse import read_document


LOG = logging.getLogger(__name__)


def options():
    provider = os.environ.get("ANALYSIS_L3_PROVIDER", "none").strip().lower()
    is_available = provider in {"ollama", "local", "anthropic", "claude", "api"}
    return {
        "ai_available": is_available,
        "provider": provider if is_available else "none",
        "default_layers": list(DEFAULT_LAYERS),
    }


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
    if kind in {"pdf", "xls"}:
        snapshots, _ = read_document(name, content)
        # The preview and upload use the same content-derived IDs. Combine sheets for position
        # evidence without replacing the editable list's section hierarchy.
        return snapshots[0].model_copy(update={
            "lines": [line for source in snapshots for line in source.lines],
            "sections": [sec for source in snapshots for sec in source.sections],
        })
    if kind not in {"gaeb_xml", "gaeb_1990"}:
        return None
    parsed = gaeb_xml(content) if kind == "gaeb_xml" else gaeb_1990(content)
    return adapter.from_import(parsed, document=SourceDocument(filename=name, format=kind))


def _is_line_unchanged(line, match) -> bool:
    line_up = line.source_amounts.unit_price if line.source_amounts else (line.price.unit_price if line.price else None)
    match_up = match.source_amounts.unit_price if match.source_amounts else None
    return (
        line.quantity == match.quantity
        and line.unit == match.unit
        and line_up == match_up
    )


def _attach_source(snapshot, source, original_codes):
    by_code = defaultdict(list)
    for line in source.lines:
        by_code[_code(line.code)].append(line)
    # Use only unambiguous matches. Keep the file's stated amount only while its inputs agree
    # with the draft. Changing quantity or price replaces the draft amount with a calculation.
    pairs = []
    source_lines = source.line_by_id()
    for line in snapshot.lines:
        match_by_id = source_lines.get(line.id)
        if match_by_id is not None:
            matches = [match_by_id]
        elif line.id in original_codes:
            matches = by_code.get(_code(original_codes[line.id]), [])
        else:
            continue
        if len(matches) != 1:
            continue
        match = matches[0]
        pairs.append((line, match))
    current_ids = {match.id: line.id for line, match in pairs}

    unchanged_line_ids = set()
    for line, match in pairs:
        line.gaeb_flags = match.gaeb_flags
        line.source_locator = match.source_locator
        if match.source_locator and source.project.source_document.format in {"xls", "pdf"}:
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

        if _is_line_unchanged(line, match):
            unchanged_line_ids.add(line.id)
            if match.source_amounts:
                from analysis.contracts import SourceAmounts
                line.source_amounts = SourceAmounts(
                    unit_price=match.source_amounts.unit_price,
                    line_amount=match.source_amounts.line_amount,
                )

    # Attach section stated totals and discount/lump-sum evidence when all subtree lines are unchanged
    from analysis.layer1.common import section_subtrees
    source_subtrees_map = section_subtrees(source)
    snap_subtrees_map = section_subtrees(snapshot)

    source_sec_by_code = defaultdict(list)
    for s in source.sections:
        source_sec_by_code[_code(s.code)].append(s)

    matched_line_map = {line.id: match.id for line, match in pairs}

    for snap_sec in snapshot.sections:
        sec_matches = source_sec_by_code.get(_code(snap_sec.code), [])
        if len(sec_matches) != 1:
            continue
        match_sec = sec_matches[0]
        snap_line_ids = [l.id for l in snapshot.lines if l.section_id in snap_subtrees_map.get(snap_sec.id, set())]
        source_line_ids = {m.id for m in source.lines if m.section_id in source_subtrees_map.get(match_sec.id, set())}
        if (len(snap_line_ids) == len(source_line_ids)
                and all(lid in unchanged_line_ids and matched_line_map.get(lid) in source_line_ids for lid in snap_line_ids)):
            snap_sec.stated_total = match_sec.stated_total
            snap_sec.stated_total_after_discount = match_sec.stated_total_after_discount
            snap_sec.stated_lump_sum_total = match_sec.stated_lump_sum_total

    # Attach BOM stated net total when all lines in the list are unchanged
    if len(snapshot.lines) == len(source.lines) and len(unchanged_line_ids) == len(snapshot.lines):
        snapshot.bom.stated_net_total = source.bom.stated_net_total

    return bool(pairs)


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
    for section in data["sections"]:
        if not isinstance(section, dict) or not isinstance(section.get("id"), str):
            raise ValueError("The list has an invalid category hierarchy.")
    try:
        snapshot = adapter.from_data(data)
    except (AttributeError, KeyError, TypeError, ValueError) as error:
        raise ValueError("The list contains invalid assessment data.") from error
    return snapshot, layers


def run(payload, connection=None, workspace=None, list_id=None, file_id=None, filename=None):
    snapshot, layers = prepare(payload)
    used_source = False
    source_notice = None
    if (file_id or filename) and connection is not None:
        try:
            source = _source(connection, workspace, list_id, file_id, filename)
        except (LookupError, ValueError, SyntaxError):
            source = None
            source_notice = "The original tender file could not be checked. Findings are based on the editable list."
        if source:
            original_codes = payload.get("original_codes")
            if isinstance(original_codes, dict):
                used_source = _attach_source(snapshot, source, original_codes)
            if used_source and source.project.source_document.format in {"xls", "pdf"}:
                snapshot.import_warnings = source.import_warnings
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
    return {**result.model_dump(mode="json"), "used_source": used_source, "source_notice": source_notice}


def _uploaded_input(document):
    phase_match = re.fullmatch(r"[XD]?(8[1-6])", str(document.get("phase") or ""), re.I)
    phase = phase_match[1] if phase_match else None
    currency = document.get("currency")
    bid = phase in {"84", "86"}
    sections = {}

    def add_section(code, label, parent_id):
        sections.setdefault(code, {"id": code, "code": code, "parent_id": parent_id, "title": label,
                                   "code_parts": code.split(".") if phase else []})

    def visit(nodes, parent_id=None):
        for node in nodes:
            add_section(node["oz"], node.get("label"), parent_id)
            visit(node.get("children") or [], node["oz"])

    visit(document.get("tree") or [])
    lines = []
    original_codes = {}
    for position in document["positions"]:
        section_id = None
        for part in position.get("path") or []:
            add_section(part["oz"], part.get("label"), section_id)
            section_id = part["oz"]
        unit = position.get("unit")
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
        if bid:
            line["source_amounts"] = {"unit_price": position.get("up")}
        elif position.get("up") is not None:
            line["price"] = {"unit_price": position["up"], "currency": currency, "source": "client"}
        if line["code"]:
            original_codes[line["id"]] = line["code"]
        lines.append(line)
    return {
        "snapshot": {
            "project": {"currency": currency, "gaeb_phase": phase,
                        "source_document": {"filename": document.get("fileName"), "format": document["source"]["kind"]}},
            "bom": {"title": document.get("title")},
            "sections": list(sections.values()),
            "lines": lines,
        },
        "original_codes": original_codes,
        "layers": [*DEFAULT_LAYERS, 3] if options()["ai_available"] else list(DEFAULT_LAYERS),
    }


MAX_RETRIES = 3


def _apply_edits(document: dict, edits: dict | None) -> dict:
    if not edits or not isinstance(edits, dict):
        return document
    import copy
    doc = copy.deepcopy(document)
    positions = doc.get("positions", [])
    if not isinstance(positions, list):
        return doc

    set_qty = edits.get("setQty") or {}
    set_up = edits.get("setUp") or {}
    patch_pos = edits.get("patchPosition") or {}
    removed = set(edits.get("removePositions") or [])
    added = edits.get("addPosition") or []

    filtered = []
    for pos in positions:
        if not isinstance(pos, dict):
            continue
        pid = pos.get("id")
        if pid in removed:
            continue
        p = dict(pos)
        if pid in set_qty:
            p["qty"] = set_qty[pid]
        if pid in set_up:
            p["up"] = set_up[pid]
        if pid in patch_pos and isinstance(patch_pos[pid], dict):
            p.update(patch_pos[pid])
        filtered.append(p)

    for add_item in added:
        if isinstance(add_item, dict):
            filtered.append(dict(add_item))

    doc["positions"] = filtered
    return doc


def enqueue(connection, workspace, writes, revision=None):
    list_ids = {key for collection, key, _ in writes if collection in {"userLists", "edits", "listPatch"}}
    for collection, key, value in writes:
        if collection == "userDocuments" and isinstance(value, dict) and isinstance(value.get("listId"), str):
            list_ids.add(value["listId"])
        elif collection == "documentLinks" and isinstance(value, dict):
            for link_key in ("listId", "sourceListId", "targetListId"):
                if isinstance(value.get(link_key), str):
                    list_ids.add(value[link_key])
    if not list_ids:
        return
    if revision is None:
        rev_row = connection.execute(
            "SELECT revision FROM workspace_sync WHERE workspace = %s", (workspace,)
        ).fetchone()
        revision = rev_row["revision"] if rev_row else 1

    connection.execute(
        """
        INSERT INTO workspace_assessment (workspace, list_id, revision, state, retries)
        SELECT lists.workspace, lists.record_id, %s, 'queued', 0
        FROM workspace_record lists
        WHERE lists.workspace=%s AND lists.collection='userLists' AND lists.record_id=ANY(%s)
          AND lists.value->'source'->>'kind' IN ('gaeb-xml', 'gaeb90', 'pdf', 'docx', 'csv', 'xlsx', 'json')
          AND CASE WHEN jsonb_typeof(lists.value->'positions') = 'array'
              THEN jsonb_array_length(lists.value->'positions') > 0 ELSE false END
        ON CONFLICT (workspace, list_id)
        DO UPDATE SET revision = EXCLUDED.revision, state = 'queued', retries = 0
        """, (revision, workspace, list(list_ids)),
    )


def status(connection, workspace, list_id):
    result = connection.execute(
        """
        SELECT a.state, a.report, a.revision AS target_revision, a.assessed_revision, a.retries
        FROM workspace_assessment a
        WHERE a.workspace=%s AND a.list_id=%s
        """,
        (workspace, list_id),
    ).fetchone()
    if not result:
        raise LookupError("Upload assessment not found.")

    state = result["state"]
    report = result["report"]
    target_rev = result.get("target_revision") or result.get("revision") or 1
    assessed_rev = result.get("assessed_revision")

    if report is not None:
        report_data = dict(report) if isinstance(report, dict) else report
        is_outdated = (assessed_rev is not None and assessed_rev < target_rev)
        report_data["outdated"] = is_outdated
        report_data["assessed_revision"] = assessed_rev
        report_data["target_revision"] = target_rev
        effective_state = "stale" if (is_outdated and state in ("queued", "running", "ready")) else state
        report_data["state"] = effective_state
        return {"state": effective_state, "report": report_data, "outdated": is_outdated}

    if state == "failed":
        return {"state": "failed", "report": None, "retries": result.get("retries", 0)}

    return {"state": "queued" if state in ("queued", "running") else state, "report": None}


def assess_next(connection):
    with connection.transaction():
        job = connection.execute(
            """
            UPDATE workspace_assessment a
            SET state='running', claimed_at=now()
            WHERE (a.workspace, a.list_id) = (
                SELECT sub.workspace, sub.list_id FROM workspace_assessment sub
                WHERE sub.state='queued'
                   OR (sub.state='running' AND sub.claimed_at < now() - INTERVAL '3 minutes')
                ORDER BY sub.workspace, sub.list_id
                FOR UPDATE OF sub SKIP LOCKED
                LIMIT 1
            )
            RETURNING a.workspace, a.list_id, a.revision, a.retries
            """,
        ).fetchone()
    if not job:
        return False

    workspace, list_id, target_revision, retries = (
        job["workspace"], job["list_id"], job["revision"], job["retries"]
    )

    doc_row = connection.execute(
        "SELECT value FROM workspace_record WHERE workspace=%s AND collection='userLists' AND record_id=%s",
        (workspace, list_id),
    ).fetchone()
    if not doc_row or not doc_row.get("value"):
        with connection.transaction():
            connection.execute(
                "UPDATE workspace_assessment SET state='failed', claimed_at=NULL WHERE workspace=%s AND list_id=%s",
                (workspace, list_id),
            )
        return True

    document = doc_row["value"]
    edits_row = connection.execute(
        "SELECT value FROM workspace_record WHERE workspace=%s AND collection='edits' AND record_id=%s",
        (workspace, list_id),
    ).fetchone()
    effective_doc = _apply_edits(document, edits_row["value"] if edits_row else None)

    filename = (
        effective_doc.get("fileName")
        if effective_doc.get("source", {}).get("kind") in {"gaeb-xml", "gaeb90", "pdf", "xlsx"}
        else None
    )

    patch_row = connection.execute(
        "SELECT value FROM workspace_record WHERE workspace=%s AND collection='listPatch' AND record_id=%s",
        (workspace, list_id),
    ).fetchone()
    decisions = (patch_row["value"] or {}).get("findingDecisions") if patch_row and patch_row.get("value") else {}

    success = False
    report = None
    try:
        report = run(_uploaded_input(effective_doc), connection, workspace, list_id, filename=filename)
        if isinstance(report, dict) and isinstance(report.get("findings"), list) and isinstance(decisions, dict):
            for finding in report["findings"]:
                if isinstance(finding, dict) and finding.get("id") in decisions:
                    dec = decisions[finding["id"]]
                    if isinstance(dec, dict) and dec.get("status"):
                        finding["status"] = dec["status"]
        success = True
    except psycopg.OperationalError:
        raise
    except Exception:
        LOG.exception("Could not assess an uploaded list")
        success = False

    with connection.transaction():
        current = connection.execute(
            "SELECT revision, retries FROM workspace_assessment WHERE workspace=%s AND list_id=%s FOR UPDATE",
            (workspace, list_id),
        ).fetchone()
        if not current:
            return True

        curr_rev = current["revision"]
        if curr_rev > target_revision:
            connection.execute(
                "UPDATE workspace_assessment SET state='queued', claimed_at=NULL WHERE workspace=%s AND list_id=%s",
                (workspace, list_id),
            )
            return True

        if success:
            connection.execute(
                """
                UPDATE workspace_assessment
                SET state='ready', report=%s, assessed_revision=%s, retries=0, claimed_at=NULL
                WHERE workspace=%s AND list_id=%s
                """,
                (Jsonb(report), target_revision, workspace, list_id),
            )
        else:
            if retries < MAX_RETRIES:
                connection.execute(
                    """
                    UPDATE workspace_assessment
                    SET state='queued', retries=retries+1, claimed_at=NULL
                    WHERE workspace=%s AND list_id=%s
                    """,
                    (workspace, list_id),
                )
            else:
                connection.execute(
                    """
                    UPDATE workspace_assessment
                    SET state='failed', retries=retries+1, claimed_at=NULL
                    WHERE workspace=%s AND list_id=%s
                    """,
                    (workspace, list_id),
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
