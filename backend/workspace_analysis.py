"""Run the shared BoQ analysis on an editable workspace list."""

from collections import defaultdict
import os

from analysis import adapter
from analysis.contracts import SourceDocument
from analysis.runner import DEFAULT_LAYERS, analyze
from tender_import.common import detect_format
from tender_import.legacy import gaeb_1990
from tender_import.structured import gaeb_xml


def options():
    provider = os.environ.get("ANALYSIS_L3_PROVIDER", "ollama").strip().lower()
    return {"ai_available": provider in {"ollama", "anthropic"}, "default_layers": list(DEFAULT_LAYERS)}


def _code(code):
    return tuple(part.lstrip("0") or "0" for part in str(code or "").strip(".").split("."))


def _source(connection, workspace, list_id, file_id):
    if not file_id:
        return None
    row = connection.execute(
        """
        SELECT f.content, d.value->>'name' AS name
        FROM workspace_file f JOIN workspace_record d
          ON (d.workspace, d.collection, d.record_id) = (f.workspace, 'userDocuments', f.file_id)
        LEFT JOIN workspace_record l
          ON (l.workspace, l.collection, l.record_id) = (d.workspace, 'documentLinks', d.record_id)
        WHERE f.workspace=%s AND f.file_id=%s AND d.value->>'original'='true'
          AND coalesce(l.value #>> '{}',d.value->>'listId')=%s
        """, (workspace, file_id, list_id),
    ).fetchone()
    if not row:
        return None
    content, name = bytes(row["content"]), row["name"]
    kind = detect_format(name, content)
    if kind not in {"gaeb_xml", "gaeb_1990"}:
        return None
    parsed = gaeb_xml(content) if kind == "gaeb_xml" else gaeb_1990(content)
    return adapter.from_import(parsed, document=SourceDocument(filename=name, format=kind))


def _attach_source(snapshot, source, original_codes):
    by_code = defaultdict(list)
    for line in source.lines:
        by_code[_code(line.code)].append(line)
    # Use only unambiguous matches. Keep the file's stated amount only while its inputs agree
    # with the draft. Changing quantity or price replaces the draft amount with a calculation.
    pairs = []
    for line in snapshot.lines:
        if line.id not in original_codes:
            continue
        matches = by_code.get(_code(original_codes[line.id]), [])
        if len(matches) != 1:
            continue
        match = matches[0]
        pairs.append((line, match))
    current_ids = {match.id: line.id for line, match in pairs}
    for line, match in pairs:
        line.gaeb_flags = match.gaeb_flags
        line.total_rule = match.total_rule
        line.alternative_for = current_ids.get(match.alternative_for)
        if match.pricing_basis == "lump_sum":
            line.pricing_basis = "lump_sum"
        if (match.source_amounts and line.source_amounts and line.quantity == match.quantity
                and line.source_amounts.unit_price == match.source_amounts.unit_price and line.unit == match.unit):
            line.source_amounts.line_amount = match.source_amounts.line_amount
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


def run(payload, connection=None, workspace=None, list_id=None, file_id=None):
    snapshot, layers = prepare(payload)
    used_source = False
    source_notice = None
    if file_id and connection is not None:
        try:
            source = _source(connection, workspace, list_id, file_id)
        except (LookupError, ValueError, SyntaxError):
            source = None
            source_notice = "The original GAEB file could not be checked. Findings are based on the editable list."
        if source:
            original_codes = payload.get("original_codes")
            if isinstance(original_codes, dict):
                used_source = _attach_source(snapshot, source, original_codes)
            snapshot = snapshot.with_hash()
    return {**analyze(snapshot, layers).model_dump(mode="json"),
            "used_source": used_source, "source_notice": source_notice}
