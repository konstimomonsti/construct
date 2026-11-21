"""Mutation operations and the two backends that apply them, plus the canonical form used to read files back.

An operation names a line by its seed id, never by position, so the same list of operations can edit the
document dict (JSON backend) and the X83 tree (lxml backend):

    {"op": "set", "id": ..., "field": quantity|unit|short_text|long_text|unit_price|line_amount, "value": ...}
    {"op": "remove", "id": ...}
    {"op": "insert_after", "after_id": ..., "line": {...full line dict...}}
    {"op": "swap", "a": ..., "b": ...}                  exchange the two lines' positions, codes stay
    {"op": "section_total", "code": ..., "value": ...}
    {"op": "net_total", "value": ...}
    {"op": "raw_text", "id": ..., "field": short_text|long_text, "value": ...}   text with odd whitespace
"""

from __future__ import annotations

import copy
from decimal import Decimal
from typing import Any

from lxml import etree

from . import docio
from .gaeb_writer import NAMESPACE, number, q

AMOUNT_FIELDS = {"unit_price", "line_amount"}
LINE_FIELDS = {"quantity", "unit", "short_text", "long_text"} | AMOUNT_FIELDS


# --------------------------------------------------------------------------- JSON backend


def apply_to_doc(doc: dict, ops: list[dict]) -> dict:
    """Return a new document with the operations applied."""
    doc = docio.clone(doc)
    for op in ops:
        kind = op["op"]
        if kind == "set":
            line = docio.get_line(doc, op["id"])
            if op["field"] in AMOUNT_FIELDS:
                docio.set_amount_field(line, op["field"], op["value"])
            elif op["field"] in LINE_FIELDS:
                line[op["field"]] = op["value"]
            else:
                raise ValueError(f"Cannot set {op['field']}")
        elif kind == "raw_text":
            docio.get_line(doc, op["id"])[op["field"]] = op["value"]
        elif kind == "remove":
            del doc["lines"][docio.line_index(doc, op["id"])]
        elif kind == "insert_after":
            new = copy.deepcopy(op["line"])
            doc["lines"].insert(docio.line_index(doc, op["after_id"]) + 1, new)
        elif kind == "swap":
            i, j = docio.line_index(doc, op["a"]), docio.line_index(doc, op["b"])
            doc["lines"][i], doc["lines"][j] = doc["lines"][j], doc["lines"][i]
        elif kind == "section_total":
            next(s for s in doc["sections"] if s["code"] == op["code"])["stated_total"] = op["value"]
        elif kind == "net_total":
            doc["bom"]["stated_net_total"] = op["value"]
        else:
            raise ValueError(f"Unknown operation {kind!r}")
    for order, line in enumerate(doc["lines"]):
        line["sort_order"] = order
    return doc


# --------------------------------------------------------------------------- X83 backend


def _child(node, tag):
    return node.find(q(tag))


def _set_child_text(item, tag: str, value: str | None, after: tuple[str, ...]) -> None:
    """Set, create (after the listed siblings) or remove a simple child element of an Item."""
    node = _child(item, tag)
    if value is None:
        if node is not None:
            item.remove(node)
        return
    if node is None:
        node = etree.Element(q(tag))
        anchor = next((_child(item, name) for name in after if _child(item, name) is not None), None)
        if anchor is not None:
            anchor.addnext(node)
        else:
            item.insert(0, node)
    node.text = value


def _set_text(item, field: str, value: str | None) -> None:
    """Short text lives in OutlineText/OutlTxt/TextOutlTxt, long text in DetailTxt/Text; both as p/span."""
    path = ("OutlineText", "OutlTxt", "TextOutlTxt") if field == "short_text" else ("DetailTxt", "Text")
    complete = item.find(f"{q('Description')}/{q('CompleteText')}")
    parent = complete
    for tag in path:
        node = _child(parent, tag)
        if node is None:
            node = etree.SubElement(parent, q(tag))
        parent = node
    for child in list(parent):
        parent.remove(child)
    if value is not None:
        span = etree.SubElement(etree.SubElement(parent, q("p")), q("span"))
        span.text = value


def _find_item(root, line_id: str):
    found = root.xpath(f"//n:Item[@ID='{line_id}']", namespaces={"n": NAMESPACE})
    if len(found) != 1:
        raise KeyError(f"Expected exactly one Item with ID {line_id}, found {len(found)}")
    return found[0]


def _set_totals(owner, value: Decimal | None) -> None:
    totals = _child(owner, "Totals")
    if totals is None:
        totals = etree.SubElement(owner, q("Totals"))
    total = _child(totals, "Total")
    if total is None:
        total = etree.SubElement(totals, q("Total"))
    total.text = number(value, 2)


def apply_to_tree(tree: etree._ElementTree, ops: list[dict]) -> None:
    """Edit a tree written by gaeb_writer in place."""
    root = tree.getroot()
    for op in ops:
        kind = op["op"]
        if kind == "set":
            item, field, value = _find_item(root, op["id"]), op["field"], op["value"]
            if field == "quantity":
                _set_child_text(item, "Qty", None if value is None else number(value, 3), ("LumpSumItem",))
            elif field == "unit":
                _set_child_text(item, "QU", value, ("Qty", "LumpSumItem"))
            elif field == "unit_price":
                _set_child_text(item, "UP", None if value is None else number(value, 2), ("QU", "Qty", "LumpSumItem"))
            elif field == "line_amount":
                _set_child_text(item, "IT", None if value is None else number(value, 2),
                                ("UP", "QU", "Qty", "LumpSumItem"))
            else:
                _set_text(item, field, value)
        elif kind == "raw_text":
            _set_text(_find_item(root, op["id"]), op["field"], op["value"])
        elif kind == "remove":
            item = _find_item(root, op["id"])
            item.getparent().remove(item)
        elif kind == "insert_after":
            source = _find_item(root, op["after_id"])
            new = copy.deepcopy(source)
            line = op["line"]
            new.set("ID", line["id"])
            new.set("RNoPart", line["code_parts"][-1])
            _set_child_text(new, "LumpSumItem", "Yes" if (line.get("gaeb_flags") or {}).get("LumpSumItem") == "Yes"
                            else None, ())
            _set_child_text(new, "Qty", None if line["quantity"] is None else number(line["quantity"], 3),
                            ("LumpSumItem",))
            _set_child_text(new, "QU", line["unit"], ("Qty", "LumpSumItem"))
            amounts = line.get("source_amounts") or {}
            _set_child_text(new, "UP", None if amounts.get("unit_price") is None else number(amounts["unit_price"], 2),
                            ("QU", "Qty", "LumpSumItem"))
            _set_child_text(new, "IT", None if amounts.get("line_amount") is None else number(amounts["line_amount"], 2),
                            ("UP", "QU", "Qty", "LumpSumItem"))
            _set_text(new, "short_text", line["short_text"])
            _set_text(new, "long_text", line["long_text"])
            source.addnext(new)
        elif kind == "swap":
            a, b = _find_item(root, op["a"]), _find_item(root, op["b"])
            a_parent, b_parent = a.getparent(), b.getparent()
            a_index, b_index = a_parent.index(a), b_parent.index(b)
            a_parent.remove(a)
            b_parent.remove(b)
            a_parent.insert(a_index, b)
            b_parent.insert(b_index, a)
        elif kind == "section_total":
            category = _find_section(root, op["code"])
            _set_totals(category, op["value"])
        elif kind == "net_total":
            _set_totals(root.xpath("//n:BoQInfo", namespaces={"n": NAMESPACE})[0], op["value"])
        else:
            raise ValueError(f"Unknown operation {kind!r}")


def _find_section(root, code: str):
    """A BoQCtgy by its full code: walk down the RNoPart path."""
    node = root.xpath("//n:BoQ/n:BoQBody", namespaces={"n": NAMESPACE})[0]
    parts = code.split(".")
    for index, part in enumerate(parts):
        node = next(child for child in node.findall(q("BoQCtgy")) if child.get("RNoPart") == part)
        if index < len(parts) - 1:
            node = node.find(q("BoQBody"))
    return node


# --------------------------------------------------------------------------- canonical form and diff


def canon_from_input(analysis_input) -> dict:
    """The fields the evaluation cares about, from an AnalysisInput (read back from a file or JSON)."""
    sections = {section.id: section for section in analysis_input.sections}
    lines = []
    seen: dict[str, int] = {}
    for line in analysis_input.lines:
        occurrence = seen[line.code] = seen.get(line.code, -1) + 1
        amounts = line.source_amounts
        lines.append({
            "key": f"{line.code}#{occurrence}", "code": line.code,
            "section": sections[line.section_id].code if line.section_id in sections else None,
            "short_text": line.short_text, "long_text": line.long_text, "quantity": line.quantity,
            "unit": line.unit_raw, "pricing_basis": line.pricing_basis,
            "unit_price": amounts.unit_price if amounts else None,
            "line_amount": amounts.line_amount if amounts else None,
        })
    return {
        "lines": lines,
        "sections": [{"code": s.code, "title": s.title, "parent": sections[s.parent_id].code
                      if s.parent_id in sections else None, "stated_total": s.stated_total}
                     for s in analysis_input.sections],
        "net_total": analysis_input.bom.stated_net_total,
        "title": analysis_input.bom.title,
    }


def _same(a: Any, b: Any) -> bool:
    return a == b  # Decimal("640.000") == Decimal("640")


def diff(before: dict, after: dict) -> set[tuple]:
    """Every difference between two canonical documents as a set of tuples.

    ("line", key, field) a field changed, ("added", key) / ("removed", key) a line appeared or went,
    ("order", section) the order of a section's lines changed, ("section", code, field), ("net_total",).
    """
    changes: set[tuple] = set()
    old = {line["key"]: line for line in before["lines"]}
    new = {line["key"]: line for line in after["lines"]}
    for key in old.keys() - new.keys():
        changes.add(("removed", key))
    for key in new.keys() - old.keys():
        changes.add(("added", key))
    for key in old.keys() & new.keys():
        for field in ("section", "short_text", "long_text", "quantity", "unit", "pricing_basis", "unit_price",
                      "line_amount"):
            if not _same(old[key][field], new[key][field]):
                changes.add(("line", key, field))
    for section in {line["section"] for line in before["lines"]} | {line["section"] for line in after["lines"]}:
        order_before = [line["key"] for line in before["lines"] if line["section"] == section and line["key"] in new]
        order_after = [line["key"] for line in after["lines"] if line["section"] == section and line["key"] in old]
        if order_before != order_after:
            changes.add(("order", section))
    old_sections = {s["code"]: s for s in before["sections"]}
    new_sections = {s["code"]: s for s in after["sections"]}
    for code in old_sections.keys() ^ new_sections.keys():
        changes.add(("section", code, "presence"))
    for code in old_sections.keys() & new_sections.keys():
        for field in ("title", "parent", "stated_total"):
            if not _same(old_sections[code][field], new_sections[code][field]):
                changes.add(("section", code, field))
    if not _same(before["net_total"], after["net_total"]):
        changes.add(("net_total",))
    if before["title"] != after["title"]:
        changes.add(("title",))
    return changes


def is_derived(change: tuple) -> bool:
    """Differences that follow from a planted change by plain arithmetic (amounts and totals)."""
    return change[0] == "net_total" or (change[0] == "section" and change[2] == "stated_total") \
        or (change[0] == "line" and change[2] == "line_amount")
