"""Run the shared BoQ analysis and retain one report per uploaded list."""

from collections import Counter, defaultdict
from decimal import Decimal
from hashlib import sha256
import json
import logging
import re
from threading import Thread
import time

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from analysis import adapter
from analysis.contracts import Section, SourceDocument
from analysis.layer3 import empty_outcome
from analysis.layer3.provider import ProviderUnavailable, check_credentials, configured_provider
from analysis.runner import DEFAULT_LAYERS, analyze
from tender_import.common import detect_format
from tender_import.legacy import gaeb_1990
from tender_import.structured import gaeb_xml
from workspace_parse import read_document


LOG = logging.getLogger(__name__)
EXCLUDED_REPORT_RULES = frozenset({"L1.TEXT.SPEC_PLACEHOLDER"})


def options():
    provider = None
    try:
        provider = configured_provider()
        check_credentials(provider)
    except ProviderUnavailable:
        state = "unavailable"
    else:
        state = "disabled" if provider == "none" else "configured"
    return {
        "ai_available": state == "configured",
        "provider": provider or "none",
        "provider_state": state,
        "default_layers": list(DEFAULT_LAYERS),
    }


def _code(code):
    return tuple(part.lstrip("0") or "0" for part in str(code or "").strip(".").split("."))


def _source(connection, workspace, list_id, file_id, filename):
    row = _source_row(connection, workspace, list_id, file_id, filename)
    return _parse_source(row) if row else None


def _source_row(connection, workspace, list_id, file_id, filename):
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
        LIMIT 2
        """, (workspace, list_id, file_id, file_id, filename, filename),
    ).fetchall()
    return row[0] if len(row) == 1 else None


def _parse_source(row):
    content, name = bytes(row["content"]), row["name"]
    kind = detect_format(name, content)
    if kind in {"pdf", "xls"}:
        snapshots, _ = read_document(name, content)
        if len(snapshots) == 1:
            return snapshots[0]
        lines, sections = [], []
        for index, sheet in enumerate(snapshots, 1):
            prefix = f"S{index}"
            root_id = adapter.stable_id(sheet.project.source_document.id, prefix)
            sections.append(Section(id=root_id, code=prefix, sort_order=index, stated_total=sheet.bom.stated_net_total))
            sections.extend(section.model_copy(update={
                "code": f"{prefix}.{section.code or section.id}",
                "parent_id": section.parent_id or root_id,
            }) for section in sheet.sections)
            lines.extend(line.model_copy(update={"section_id": line.section_id or root_id}) for line in sheet.lines)
        return snapshots[0].model_copy(update={
            "lines": lines, "sections": sections,
            "bom": snapshots[0].bom.model_copy(update={"stated_net_total": None}),
        })
    if kind not in {"gaeb_xml", "gaeb_1990"}:
        return None
    parsed = gaeb_xml(content) if kind == "gaeb_xml" else gaeb_1990(content)
    return adapter.from_import(parsed, document=SourceDocument(id=sha256(content).hexdigest(), filename=name, format=kind))


def _attach_source(snapshot, source, original_codes):
    kind = source.project.source_document.format
    is_gaeb = kind in {"gaeb_xml", "gaeb_1990"}
    by_code = defaultdict(list)
    for line in source.lines:
        if line.code:
            by_code[_code(line.code)].append(line)
    # Use only unambiguous matches. Keep the file's stated amount only while its inputs agree
    # with the draft. Changing quantity or price replaces the draft amount with a calculation.
    pairs = []
    source_lines = source.line_by_id()
    for line in snapshot.lines:
        match_by_id = source_lines.get(line.id)
        if match_by_id is not None and (not is_gaeb or _code(match_by_id.code) == _code(original_codes.get(line.id))):
            matches = [match_by_id]
        elif is_gaeb and line.id in original_codes:
            matches = by_code.get(_code(original_codes[line.id]), [])
        else:
            continue
        if len(matches) != 1:
            continue
        match = matches[0]
        pairs.append((line, match))
    counts = Counter(match.id for _, match in pairs)
    pairs = [(line, match) for line, match in pairs if counts[match.id] == 1]
    current_ids = {match.id: line.id for line, match in pairs}
    unchanged = {}
    for line, match in pairs:
        line.gaeb_flags = match.gaeb_flags
        line.source_locator = {**match.source_locator, "source_document_id": source.project.source_document.id}
        if match.source_locator and kind in {"xls", "pdf"}:
            if line.quantity == match.quantity:
                line.quantity_raw = match.quantity_raw
            if match.unit is None and not line.unit_raw:
                line.unit = None
        line.total_rule = match.total_rule
        line.alternative_for = current_ids.get(match.alternative_for)
        if match.pricing_basis == "lump_sum":
            line.pricing_basis = "lump_sum"
        draft_rate = line.price.unit_price if line.price else (
            line.source_amounts.unit_price if line.source_amounts else None
        )
        source_rate = match.source_amounts.unit_price if match.source_amounts else None
        same_unit = line.unit == match.unit and (
            line.unit is not None or (line.unit_raw or "").strip().casefold() == (match.unit_raw or "").strip().casefold()
        )
        same_currency = not source.project.currency or source.project.currency == snapshot.project.currency
        if line.quantity == match.quantity and same_unit and draft_rate == source_rate and same_currency:
            if match.source_amounts:
                line.source_amounts = match.source_amounts.model_copy()
            if _code(line.code) == _code(match.code):
                unchanged[line.id] = match.id
        elif line.source_amounts:
            line.source_amounts.line_amount = None
    if not source.project.currency or source.project.currency == snapshot.project.currency:
        _attach_original_totals(snapshot, source, unchanged)
    return bool(pairs)


def _attach_original_totals(snapshot, source, unchanged_lines):
    """Carry written totals only for subtrees that still match the original pricing inputs."""
    source_sections = defaultdict(list)
    source_children = defaultdict(list)
    source_items = defaultdict(list)
    for section in source.sections:
        if section.code:
            source_sections[_code(section.code)].append(section)
        source_children[section.parent_id].append(section.id)
    for line in source.lines:
        source_items[line.section_id].append(line.id)

    draft_children = defaultdict(list)
    draft_items = defaultdict(list)
    matched_sections = {}
    for section in snapshot.sections:
        draft_children[section.parent_id].append(section.id)
        matches = source_sections.get(_code(section.code), []) if section.code else []
        if len(matches) == 1:
            matched_sections[section.id] = matches[0]
    for line in snapshot.lines:
        draft_items[line.section_id].append(unchanged_lines.get(line.id))

    from analysis.graph import validate_graph
    draft_graph = validate_graph(snapshot)
    source_graph = validate_graph(source)
    draft_order = [None]
    for parent in draft_order:
        draft_order.extend(draft_graph.safe_section_children.get(parent, []))
    sections = {section.id: section for section in snapshot.sections}
    unchanged = set()
    for draft_id in reversed(draft_order):
        original = matched_sections.get(draft_id)
        if draft_id is not None and (original is None or original.id in source_graph.invalid_section_ids):
            continue
        original_id = original.id if original else None
        children = draft_children[draft_id]
        if (Counter(draft_items[draft_id]) != Counter(source_items[original_id])
                or not all(child in unchanged for child in children)
                or Counter(matched_sections[child].id for child in children) != Counter(source_children[original_id])):
            continue
        unchanged.add(draft_id)
        if draft_id is not None:
            section = sections[draft_id]
            section.stated_total = original.stated_total
            section.stated_total_after_discount = original.stated_total_after_discount
            section.stated_lump_sum_total = original.stated_lump_sum_total
    if None in unchanged and draft_graph.is_valid and source_graph.is_valid:
        snapshot.bom.stated_net_total = source.bom.stated_net_total


def prepare(payload, *, allow_empty=False):
    layers = payload.get("layers", list(DEFAULT_LAYERS))
    if (not isinstance(layers, list) or not layers
            or any(type(layer) is not int or layer not in {1, 2, 3} for layer in layers)):
        raise ValueError("Choose analysis layers from 1, 2 and 3.")
    data = payload.get("snapshot")
    if (not isinstance(data, dict) or not isinstance(data.get("lines"), list) or (not allow_empty and not data["lines"])
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


def run(payload, connection=None, workspace=None, list_id=None, file_id=None, filename=None, *,
        source_row=None, allow_empty=False):
    snapshot, layers = prepare(payload, allow_empty=allow_empty)
    used_source = False
    source_notice = None
    if file_id or filename or source_row is not None:
        try:
            if source_row is not None:
                source = _parse_source(source_row)
            else:
                source = _source(connection, workspace, list_id, file_id, filename) if connection is not None else None
        except (LookupError, ValueError, SyntaxError):
            source = None
            source_notice = "The original tender file could not be checked. Findings are based on the editable list."
        if source:
            original_codes = payload.get("original_codes")
            if isinstance(original_codes, dict):
                used_source = _attach_source(snapshot, source, original_codes)
            if used_source and source.project.source_document.format in {"xls", "pdf"}:
                snapshot.import_warnings = [*snapshot.import_warnings, *source.import_warnings]
            snapshot = snapshot.with_hash()
        if not used_source and not source_notice:
            source_notice = "Original file evidence is missing or could not be matched. Findings are based on the working list."
    try:
        result = analyze(snapshot, layers, excluded_report_rules=EXCLUDED_REPORT_RULES)
    except Exception:
        if 3 not in layers:
            raise
        # Layer 3 handles provider failures itself; this is the last line of defence, so an unexpected
        # crash there still leaves the reviewer with the layer 1 and 2 findings.
        LOG.warning("Layer 3 failed unexpectedly during workspace analysis")
        result = analyze(snapshot, [layer for layer in layers if layer != 3],
                         excluded_report_rules=EXCLUDED_REPORT_RULES)
        result.errors.append("layer 3: failed unexpectedly; findings are from layers 1 and 2 only")
        result.errors.append("layer 3 coverage: 0/0 batches")
        result.l3_status = empty_outcome("unavailable", "Advisory checks failed unexpectedly")
    review_metrics = None
    if result.risk:
        review_metrics = {
            "item_sections": result.risk.item_sections,
            "item_exposure": {key: [line_id, str(estimate)]
                              for key, (line_id, estimate) in result.risk.item_exposure.items()},
        }
    return {**result.model_dump(mode="json"), "used_source": used_source, "source_notice": source_notice,
            "review_metrics": review_metrics}


def _uploaded_input(document):
    phase_match = re.fullmatch(r"[XD]?(8[1-6])", str(document.get("phase") or ""), re.I)
    phase = phase_match[1] if phase_match else None
    currency = document.get("currency")
    bid = phase in {"84", "86"}
    sections = {}

    def add_section(code, label, parent_id):
        sections.setdefault(code, {"id": code, "parent_id": parent_id, "code": code, "title": label,
                                   "code_parts": code.split(".") if phase else []})

    pending = [(node, None) for node in reversed(document.get("tree") or [])]
    while pending:
        node, parent_id = pending.pop()
        code = node["oz"]
        add_section(code, node.get("label"), parent_id)
        pending.extend((child, code) for child in reversed(node.get("children") or []))
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
            "quantity": None if position.get("quantityMissing") else position.get("qty"),
            "unit": unit,
            "pricing_basis": "lump_sum" if position.get("lumpSum") or (unit or "").lower().rstrip(".") == "psch" else "unit_rate",
            "total_rule": position.get("totalRule") or "include",
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
        "layers": [*DEFAULT_LAYERS, 3] if options()["provider_state"] != "disabled" else list(DEFAULT_LAYERS),
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

    set_qty = edits.get("qty") or {}
    set_up = edits.get("up") or {}
    patch_pos = edits.get("patch") or {}
    removed = set(edits.get("removed") or [])
    added = edits.get("added") or []
    moves = edits.get("moves") or {}
    categories = edits.get("categories") or {}
    renamed = categories.get("renamed") or {}
    tree = doc.setdefault("tree", [])
    if tree is None:
        tree = doc["tree"] = []
    nodes = {}
    pending = [(node, []) for node in reversed(tree)]
    while pending:
        node, parent_path = pending.pop()
        code = node["oz"]
        node["label"] = renamed.get(code, node.get("label"))
        path = [*parent_path, {"oz": code, "label": node["label"]}]
        nodes[code] = (node, path)
        pending.extend((child, path) for child in reversed(node.get("children") or []))

    def add_category(code, label, parent):
        if code not in nodes:
            node = {"oz": code, "label": renamed.get(code, label), "children": []}
            parent_node, path = nodes.get(parent, (None, []))
            siblings = tree if parent_node is None else parent_node.setdefault("children", [])
            siblings.append(node)
            nodes[code] = (node, [*path, {"oz": code, "label": node["label"]}])

    for category in categories.get("added") or []:
        add_category(category["oz"], category.get("label"), category.get("parentOz"))

    filtered = []
    for pos in [*positions, *added]:
        if not isinstance(pos, dict):
            continue
        pid = pos.get("id")
        if pid in removed:
            continue
        p = dict(pos)
        parent = None
        for part in p.get("path") or []:
            add_category(part["oz"], part.get("label"), parent)
            parent = part["oz"]
        target = moves.get(pid)
        if target in nodes:
            p["path"] = nodes[target][1]
        if pid in patch_pos and isinstance(patch_pos[pid], dict):
            p.update(patch_pos[pid])
        if pid in set_qty:
            p["qty"] = set_qty[pid]
            p.pop("quantityMissing", None)
        if pid in set_up:
            p["up"] = set_up[pid]
        filtered.append(p)

    doc["positions"] = filtered
    return doc


def _bind_review_evidence(report, previous):
    previous = previous or {}
    reopened = set(previous.get("reopened_finding_ids", []))
    previous_findings = {finding["id"]: finding for finding in previous.get("findings", [])}

    def review_key(finding):
        material = {key: finding.get(key) for key in (
            "rule_id", "severity", "target", "related_line_ids", "message", "evidence", "suggested_fix",
        )}
        return sha256(json.dumps(material, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    for finding in report["findings"]:
        finding["review_key"] = review_key(finding)
        prior = previous_findings.get(finding["id"])
        if prior is not None and review_key(prior) != finding["review_key"]:
            reopened.add(finding["id"])
    report["reopened_finding_ids"] = sorted(reopened)


def _phase_number(document):
    match = re.fullmatch(r"[XDP]?(83|84|86)", str(document.get("phase") or ""), re.I)
    return match[1] if match else None


def _phase_validation(list_id, document, patch, predecessor, awards):
    identity = document.get("phaseIdentity")
    link = patch.get("phaseLink")
    if not isinstance(link, dict) or not isinstance(identity, dict):
        return {"state": "unverified", "reason": "An explicit package and predecessor revision are required."}
    old = (predecessor or {}).get("phaseIdentity")
    if (not predecessor or link.get("predecessorId") == list_id
            or not isinstance(old, dict) or not identity.get("packageId") or old.get("packageId") != identity.get("packageId")):
        return {"state": "invalid", "reason": "The predecessor belongs to a different or missing package."}
    if (not identity.get("revision") or not old.get("revision") or identity["revision"] != link.get("revision")
            or old["revision"] != link.get("predecessorRevision")):
        return {"state": "invalid", "reason": "A document revision does not match the link."}
    if not document.get("currency") or document["currency"] != predecessor.get("currency"):
        return {"state": "invalid", "reason": "The linked documents must use the same currency."}
    phases = (_phase_number(predecessor), _phase_number(document))
    if phases not in {("83", "84"), ("84", "86")}:
        return {"state": "invalid", "reason": "Link a tender to its offer or an offer to its award."}
    if phases[-1] == "86" and awards > 1:
        return {"state": "invalid", "reason": "More than one award claims this package."}
    keys = [[p.get("positionKey") for p in doc.get("positions", []) if isinstance(p, dict)] for doc in (predecessor, document)]
    if any(not all(isinstance(k, str) and k for k in group) or len(set(group)) != len(group) for group in keys):
        return {"state": "unverified", "reason": "The positions need unique, explicit cross-file identities."}
    if not set(keys[0]).intersection(keys[1]):
        return {"state": "invalid", "reason": "The linked revisions have no known positions in common."}
    return {"state": "verified", "predecessor_id": link["predecessorId"], "matched_positions": len(set(keys[0]) & set(keys[1]))}


def _cap_comparison(report, patch):
    cap = patch.get("capApproval")
    if (not isinstance(cap, dict) or not isinstance(cap.get("confirmationReference"), str)
            or not cap["confirmationReference"].strip()):
        reason = "A recorded cap needs explicit confirmation." if patch.get("cap") is not None else "No cap confirmation is recorded."
        return {"state": "unverified", "reason": reason}
    totals = report["totals"]
    amount = cap.get("amount")
    if (not totals["complete"] or cap.get("basis") != "working_line_net"
            or totals["currency"] != "EUR" or cap.get("currency") != totals["currency"]
            or not isinstance(amount, str) or not re.fullmatch(r"\d{1,12}(\.\d{1,2})?", amount)
            or any(f["rule_id"] in {"L1.PRICE.NEGATIVE", "L1.QTY.NEGATIVE"} for f in report["findings"])):
        return {"state": "unavailable", "reason": "Comparison requires a complete, supported EUR working net and a cap on the same basis."}
    observed, limit = Decimal(totals["working_net"]), Decimal(amount)
    state = "over" if observed > limit else "at" if observed == limit else (
        "almost" if observed * 100 >= limit * 90 else "near" if observed * 100 >= limit * 75 else "under"
    )
    return {"state": state, "working_net": str(observed), "cap": str(limit), "currency": totals["currency"],
            "confirmation_reference": cap["confirmationReference"], "basis": cap["basis"]}


def original_lists(connection, workspace, document_ids):
    if not document_ids:
        return set()
    rows = connection.execute(
        """
        SELECT coalesce(link.value #>> '{}', doc.value->>'listId') AS list_id
        FROM workspace_record doc
        LEFT JOIN workspace_record link
          ON (link.workspace, link.collection, link.record_id) = (doc.workspace, 'documentLinks', doc.record_id)
        WHERE doc.workspace=%s AND doc.collection='userDocuments' AND doc.record_id=ANY(%s)
          AND doc.value->>'original'='true'
        """, (workspace, list(document_ids)),
    )
    return {row["list_id"] for row in rows if row["list_id"]}


def enqueue(connection, workspace, list_ids, revision):
    if not list_ids:
        return

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
        DO UPDATE SET revision = EXCLUDED.revision, state = 'queued', retries = 0, claimed_at = NULL,
                      rules_only = false
        WHERE workspace_assessment.revision < EXCLUDED.revision
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
    target_rev = result["target_revision"]
    assessed_rev = result["assessed_revision"]

    if report is not None:
        report_data = dict(report) if isinstance(report, dict) else report
        is_outdated = assessed_rev != target_rev
        report_data["outdated"] = is_outdated
        report_data["assessed_revision"] = assessed_rev
        report_data["target_revision"] = target_rev
        effective_state = "stale" if is_outdated and state != "failed" else state
        advisory_state = (report_data.get("l3_status") or {}).get("state")
        if effective_state == "ready" and (
            report_data.get("graph_valid") is False or report_data.get("source_notice")
            or advisory_state in {"degraded", "unavailable"}
        ):
            effective_state = "partial"
        report_data["state"] = effective_state
        return {"state": effective_state, "report": report_data, "outdated": is_outdated}

    if state == "failed":
        return {"state": "failed", "report": None, "retries": result.get("retries", 0)}

    return {"state": state, "report": None, "target_revision": target_rev}


def assess_next(connection):
    with connection.transaction():
        connection.execute(
            """
            UPDATE workspace_assessment
            SET state='failed', claimed_at=NULL
            WHERE state='running' AND retries >= %s AND claimed_at < now() - INTERVAL '3 minutes'
            """, (MAX_RETRIES,),
        )
        job = connection.execute(
            """
            UPDATE workspace_assessment a
            SET state='running', claimed_at=clock_timestamp(), retries=a.retries+1
            WHERE (a.workspace, a.list_id) = (
                SELECT sub.workspace, sub.list_id FROM workspace_assessment sub
                WHERE sub.retries < %s AND (
                    sub.state='queued'
                    OR (sub.state='running' AND sub.claimed_at < now() - INTERVAL '3 minutes')
                )
                ORDER BY sub.workspace, sub.list_id
                FOR UPDATE OF sub SKIP LOCKED
                LIMIT 1
            )
            RETURNING a.workspace, a.list_id, a.revision, a.retries, a.claimed_at, a.rules_only, a.report
            """, (MAX_RETRIES,),
        ).fetchone()
        if not job:
            return False

        workspace, list_id = job["workspace"], job["list_id"]
        records = {
            row["collection"]: row["value"] for row in connection.execute(
                """
                SELECT collection, value FROM workspace_record
                WHERE workspace=%s AND collection IN ('userLists', 'edits', 'listPatch') AND record_id=%s
                """, (workspace, list_id),
            )
        }
        document = records.get("userLists") or {}
        patch = records.get("listPatch") or {}
        phase_link = patch.get("phaseLink")
        predecessor, awards = None, 0
        identity = document.get("phaseIdentity")
        if (isinstance(phase_link, dict) and isinstance(phase_link.get("predecessorId"), str)
                and isinstance(identity, dict) and isinstance(identity.get("packageId"), str)):
            predecessor_row = connection.execute(
                "SELECT value FROM workspace_record WHERE workspace=%s AND collection='userLists' AND record_id=%s",
                (workspace, phase_link.get("predecessorId")),
            ).fetchone()
            predecessor = predecessor_row["value"] if predecessor_row else None
            awards = connection.execute(
                """
                SELECT count(*) AS total FROM workspace_record
                WHERE workspace=%s AND collection='userLists'
                  AND value->'phaseIdentity'->>'packageId'=%s
                  AND upper(value->>'phase') IN ('86', 'X86', 'D86', 'P86')
                """, (workspace, identity["packageId"]),
            ).fetchone()["total"]
        filename = (
            document.get("fileName")
            if document.get("source", {}).get("kind") in {"gaeb-xml", "gaeb90", "pdf", "xlsx"}
            else None
        )
        original = _source_row(connection, workspace, list_id, None, filename) if filename else None

    report = None
    try:
        payload = _uploaded_input(_apply_edits(document, records.get("edits")))
        payload["original_codes"] = {
            pos["id"]: pos["oz"] for pos in document["positions"] if pos.get("oz")
        }
        if job["rules_only"]:
            payload["layers"] = list(DEFAULT_LAYERS)
        report = run(payload, filename=filename, source_row=original, allow_empty=True)
        report["assessed_edits"] = records.get("edits")
        report["phase_validation"] = _phase_validation(list_id, document, patch, predecessor, awards)
        report["cap_comparison"] = _cap_comparison(report, patch)
        _bind_review_evidence(report, job["report"])
    except psycopg.OperationalError:
        raise
    except Exception as error:
        LOG.warning("Upload assessment failed (%s), attempt %d", type(error).__name__, job["retries"])

    with connection.transaction():
        identity = (workspace, list_id, job["revision"], job["claimed_at"])
        if report is not None:
            connection.execute(
                """
                UPDATE workspace_assessment
                SET state='ready', report=%s, assessed_revision=revision, retries=0, claimed_at=NULL
                WHERE workspace=%s AND list_id=%s AND revision=%s AND claimed_at=%s AND state='running'
                """, (Jsonb(report), *identity),
            )
        else:
            state = "failed" if job["retries"] >= MAX_RETRIES else "queued"
            connection.execute(
                """
                UPDATE workspace_assessment SET state=%s, claimed_at=NULL
                WHERE workspace=%s AND list_id=%s AND revision=%s AND claimed_at=%s AND state='running'
                """, (state, *identity),
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
