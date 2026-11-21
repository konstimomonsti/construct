"""Export a seed document (see docio.py) as GAEB DA XML 3.3, phase 83 (X83).

    python -m analysis.eval.gaeb_writer analysis/eval/seeds/building_hall.json out/building_hall.X83

The file follows the structure of the official sample files: BoQInfo with the breakdown, nested BoQCtgy
elements with an Itemlist, Item with Qty, QU, UP, IT and a Description with OutlineText (short text) and
DetailTxt (long text). It is meant to be read by importer/tender_import/structured.py, and checked by
`mutate.py` which reads every file back. It has not been validated against the GAEB XSD (not in the repo).

Every Item carries the seed's line id in its ID attribute, which is how the mutator finds it again.
"""

from __future__ import annotations

import sys
from decimal import Decimal
from pathlib import Path

from lxml import etree

from . import docio

NAMESPACE = "http://www.gaeb.de/GAEB_DA_XML/DA83/3.3"


def q(tag: str) -> str:
    return f"{{{NAMESPACE}}}{tag}"


def sub(parent, tag: str, text: str | None = None, **attributes) -> etree._Element:
    node = etree.SubElement(parent, q(tag), **attributes)
    if text is not None:
        node.text = text
    return node


def number(value: Decimal | None, places: int) -> str:
    return f"{value:.{places}f}"


def paragraph(parent, text: str) -> None:
    sub(sub(parent, "p"), "span", text)


def write_totals(parent, value: Decimal | None) -> None:
    if value is not None:
        sub(sub(parent, "Totals"), "Total", number(value, 2))


def write_item(parent, line: dict) -> None:
    flags = line.get("gaeb_flags") or {}
    item = sub(parent, "Item", ID=line["id"], RNoPart=line["code_parts"][-1])
    if flags.get("LumpSumItem") == "Yes":
        sub(item, "LumpSumItem", "Yes")
    if line.get("quantity") is not None:
        sub(item, "Qty", number(line["quantity"], 3))
    if line.get("unit") is not None:
        sub(item, "QU", line["unit"])
    amounts = line.get("source_amounts") or {}
    if amounts.get("unit_price") is not None:
        sub(item, "UP", number(amounts["unit_price"], 2))
    if amounts.get("line_amount") is not None:
        sub(item, "IT", number(amounts["line_amount"], 2))
    complete = sub(sub(item, "Description"), "CompleteText")
    if line.get("long_text"):
        paragraph(sub(sub(complete, "DetailTxt"), "Text"), line["long_text"])
    if line.get("short_text"):
        paragraph(sub(sub(sub(complete, "OutlineText"), "OutlTxt"), "TextOutlTxt"), line["short_text"])


def write_section(parent, doc: dict, section: dict) -> None:
    category = sub(parent, "BoQCtgy", ID=section["id"], RNoPart=section["code_parts"][-1])
    paragraph(sub(category, "LblTx"), section["title"])
    body = sub(category, "BoQBody")
    children = [child for child in doc["sections"] if child.get("parent_id") == section["id"]]
    for child in children:
        write_section(body, doc, child)
    lines = [line for line in doc["lines"] if line.get("section_id") == section["id"]]
    if lines:
        itemlist = sub(body, "Itemlist")
        for line in lines:
            write_item(itemlist, line)
    write_totals(category, section.get("stated_total"))


def build_tree(doc: dict) -> etree._ElementTree:
    root = etree.Element(q("GAEB"), nsmap={None: NAMESPACE})
    info = sub(root, "GAEBInfo")
    sub(info, "Version", "3.3")
    sub(info, "VersDate", "2021-05")
    sub(info, "Date", "2026-11-21")
    sub(info, "ProgSystem", "construct evaluation seed writer")
    project = doc.get("project", {})
    prj = sub(root, "PrjInfo")
    sub(prj, "NamePrj", "BUILDING-HALL")
    sub(prj, "LblPrj", project.get("name"))
    sub(prj, "Cur", project.get("currency") or "EUR")
    sub(prj, "CurLbl", "Euro")
    award = sub(root, "Award")
    sub(award, "DP", project.get("gaeb_phase") or "83")
    boq = sub(award, "BoQ", ID="BOQ1")
    boq_info = sub(boq, "BoQInfo")
    sub(boq_info, "Name", "BUILDING-HALL")
    sub(boq_info, "LblBoQ", doc["bom"].get("title"))
    sub(boq_info, "Date", "2026-11-21")
    sub(boq_info, "OutlCompl", "AllTxt")
    depth = max(len(section["code_parts"]) for section in doc["sections"])
    for _ in range(depth):
        breakdown = sub(boq_info, "BoQBkdn")
        sub(breakdown, "Type", "BoQLevel")
        sub(breakdown, "Length", "2")
        sub(breakdown, "Num", "Yes")
    breakdown = sub(boq_info, "BoQBkdn")
    sub(breakdown, "Type", "Item")
    sub(breakdown, "Length", "4")
    sub(breakdown, "Num", "Yes")
    write_totals(boq_info, doc["bom"].get("stated_net_total"))
    body = sub(boq, "BoQBody")
    for section in doc["sections"]:
        if section.get("parent_id") is None:
            write_section(body, doc, section)
    return etree.ElementTree(root)


def serialize(tree: etree._ElementTree) -> bytes:
    return etree.tostring(tree, xml_declaration=True, encoding="UTF-8", pretty_print=True)


def to_bytes(doc: dict) -> bytes:
    return serialize(build_tree(doc))


def write_file(doc: dict, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(to_bytes(doc))
    return path


def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 2:
        print("usage: python -m analysis.eval.gaeb_writer SEED.json OUT.X83", file=sys.stderr)
        return 2
    written = write_file(docio.load(args[0]), args[1])
    print(f"wrote {written}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
