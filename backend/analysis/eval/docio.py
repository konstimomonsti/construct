"""The seed document: a plain dict in the shape of an AnalysisInput, with Decimals for all numbers.

Everything in the evaluation package (writer, mutator, read-back check) works on this dict, so the JSON
backend and the X83 backend start from the same data.
"""

from __future__ import annotations

import copy
from decimal import ROUND_HALF_UP, Decimal
from hashlib import sha256
import json
from pathlib import Path
import re
from typing import Any

CENT = Decimal("0.01")
_NUMBER_FIELDS = ("quantity",)


def money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def dec(value: Any) -> Decimal | None:
    return None if value is None else Decimal(str(value))


def _decimalize(doc: dict) -> dict:
    """Numbers read from JSON become Decimals (ints and floats alike)."""
    bom = doc.setdefault("bom", {})
    bom["stated_net_total"] = dec(bom.get("stated_net_total"))
    for section in doc.get("sections", []):
        section["stated_total"] = dec(section.get("stated_total"))
    for line in doc.get("lines", []):
        line["quantity"] = dec(line.get("quantity"))
        amounts = line.get("source_amounts")
        if amounts:
            amounts["unit_price"] = dec(amounts.get("unit_price"))
            amounts["line_amount"] = dec(amounts.get("line_amount"))
    return doc


def loads(text: str) -> dict:
    return _decimalize(json.loads(text, parse_float=Decimal))


def load(path: str | Path) -> dict:
    return loads(Path(path).read_text(encoding="utf-8-sig"))


def _plain(value: Any) -> Any:
    """Decimals become marker strings so that they are written as exact JSON numbers."""
    if isinstance(value, Decimal):
        return f"@@{value:f}@@"
    if isinstance(value, dict):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return value


def dumps(doc: dict) -> str:
    text = json.dumps(_plain(doc), indent=2, ensure_ascii=False)
    return re.sub(r'"@@(-?[0-9.]+)@@"', r"\1", text) + "\n"


def dump(doc: dict, path: str | Path) -> None:
    Path(path).write_text(dumps(doc), encoding="utf-8", newline="\n")


def file_hash(path: str | Path) -> str:
    return sha256(Path(path).read_bytes()).hexdigest()


def clone(doc: dict) -> dict:
    return copy.deepcopy(doc)


# --------------------------------------------------------------------------- structure helpers


def line_index(doc: dict, line_id: str) -> int:
    for index, line in enumerate(doc["lines"]):
        if line["id"] == line_id:
            return index
    raise KeyError(f"No line with id {line_id}")


def get_line(doc: dict, line_id: str) -> dict:
    return doc["lines"][line_index(doc, line_id)]


def section_by_id(doc: dict) -> dict[str, dict]:
    return {section["id"]: section for section in doc["sections"]}


def ancestors(doc: dict, section_id: str | None) -> list[dict]:
    """The section and all its parents, innermost first."""
    sections = section_by_id(doc)
    chain = []
    while section_id in sections:
        chain.append(sections[section_id])
        section_id = sections[section_id].get("parent_id")
    return chain


def line_amount(line: dict) -> Decimal | None:
    amounts = line.get("source_amounts") or {}
    return amounts.get("line_amount")


def unit_price(line: dict) -> Decimal | None:
    amounts = line.get("source_amounts") or {}
    return amounts.get("unit_price")


def set_amount_field(line: dict, field: str, value: Decimal | None) -> None:
    amounts = line.setdefault("source_amounts", {"unit_price": None, "line_amount": None})
    amounts[field] = value


def expected_line_amount(line: dict) -> Decimal | None:
    quantity, price = line.get("quantity"), unit_price(line)
    if quantity is None or price is None:
        return None
    return money(quantity * price)


def section_sum(doc: dict, section_id: str) -> Decimal:
    """Sum of the stated line amounts below a section (all seed lines are counted items)."""
    members = {section["id"] for section in doc["sections"]
               if any(s["id"] == section_id for s in ancestors(doc, section["id"]))}
    return sum((line_amount(line) or Decimal(0) for line in doc["lines"] if line.get("section_id") in members),
               Decimal(0))


def net_sum(doc: dict) -> Decimal:
    return sum((line_amount(line) or Decimal(0) for line in doc["lines"]), Decimal(0))


def recompute_totals(doc: dict) -> None:
    """Make every stated subtotal and the net total equal the sum of the stated line amounts."""
    for section in doc["sections"]:
        section["stated_total"] = section_sum(doc, section["id"])
    doc["bom"]["stated_net_total"] = net_sum(doc)


def consistent_amounts(doc: dict) -> None:
    """Set every line amount to quantity x unit price (lump sums included), then the totals."""
    for line in doc["lines"]:
        if unit_price(line) is not None:
            set_amount_field(line, "line_amount", expected_line_amount(line))
    recompute_totals(doc)
