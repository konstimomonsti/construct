"""Read normalized AnalysisInput JSON or the specification's Item array.

This standalone adapter deliberately has no database or raw GAEB/PDF parser.
"""

import copy
import hashlib
import json
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from ..contracts import AnalysisInput
from .quantities import normalize_unit


def parse_number(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip().replace("\u00a0", "").replace(" ", "")
    if not text:
        return None
    if "," in text and "." in text:
        if text.rfind(",") > text.rfind("."):
            text = text.replace(".", "").replace(",", ".")
        else:
            text = text.replace(",", "")
    elif "," in text:
        text = text.replace(",", ".")
    try:
        number = Decimal(text)
        return number if number.is_finite() else None
    except InvalidOperation:
        return None


def canonical_hash(input: AnalysisInput) -> str:
    payload = input.model_dump(mode="json", exclude={"input_hash"})
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _text(value: Any) -> str | None:
    return " ".join(str(value).split()) if value is not None else None


def _flat_input(items: list, filename: str | None) -> dict:
    lines, sections = [], {}
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise ValueError(f"Item {index} must be a JSON object")
        line = copy.deepcopy(item)
        group = _text(line.pop("trade_group", None))
        if group:
            section_id = "trade_" + hashlib.sha256(group.encode("utf-8")).hexdigest()[:16]
            sections.setdefault(section_id, {
                "id": section_id, "title": group, "sort_order": len(sections),
            })
            line.setdefault("section_id", section_id)
        code = line.pop("oz", None)
        line.setdefault("code", str(code) if code is not None else None)
        identity = json.dumps([line.get("code"), group, index], ensure_ascii=False)
        line.setdefault("id", "line_" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24])
        line.setdefault("sort_order", index)
        line.setdefault("source_locator", {"item_index": index, "filename": filename})
        lines.append(line)
    return {"project": {"source_document": {"filename": filename, "format": "json"}},
            "lines": lines, "sections": list(sections.values())}


def from_data(payload: dict | list, *, filename: str | None = None) -> AnalysisInput:
    if isinstance(payload, list):
        data = _flat_input(payload, filename)
    elif isinstance(payload, dict) and "items" in payload and "lines" not in payload:
        if not isinstance(payload["items"], list):
            raise ValueError("'items' must be an array")
        data = _flat_input(payload["items"], filename)
        for key in ("project", "bom", "areas", "import_warnings"):
            if key in payload:
                data[key] = copy.deepcopy(payload[key])
    elif isinstance(payload, dict) and isinstance(payload.get("lines"), list):
        data = copy.deepcopy(payload)
    else:
        raise ValueError("Expected an AnalysisInput object, an Item array, or {'items': [...]}")
    data.setdefault("import_warnings", [])
    if not isinstance(data["import_warnings"], list):
        raise ValueError("import_warnings must be an array")

    def numeric(container: dict, key: str, locator: dict) -> None:
        if key not in container:
            return
        raw = container[key]
        container[key] = parse_number(raw)
        if raw is not None and str(raw).strip() and container[key] is None:
            data["import_warnings"].append({
                "code": "INVALID_NUMBER", "message": f"Cannot parse {key}: {raw!r}",
                "locator": {**locator, "raw": str(raw)},
            })

    for index, line in enumerate(data["lines"]):
        if not isinstance(line, dict):
            raise ValueError(f"Line {index} must be a JSON object")
        line.setdefault("id", f"line_{index}")
        line.setdefault("sort_order", index)
        line.setdefault("code_parts", str(line["code"]).split(".") if line.get("code") else [])
        line.setdefault("quantity_raw", str(line["quantity"]) if line.get("quantity") is not None else None)
        line.setdefault("unit_raw", line.get("unit"))
        line["unit"] = normalize_unit(line.get("unit"))
        for field in ("short_text", "long_text"):
            line[field] = _text(line.get(field))
        locator = line.get("source_locator", {"line_id": line["id"]})
        numeric(line, "quantity", locator)
        distributions = line.get("distributions", [])
        if not isinstance(distributions, list) or any(not isinstance(d, dict) for d in distributions):
            raise ValueError(f"Line {index}: distributions must be an array of objects")
        for distribution in distributions:
            numeric(distribution, "quantity", {**locator, "area_id": distribution.get("area_id")})
        for field in ("source_amounts", "price"):
            if line.get(field) is not None:
                if not isinstance(line[field], dict):
                    raise ValueError(f"Line {index}: {field} must be an object or null")
                numeric(line[field], "unit_price", locator)
                numeric(line[field], "line_amount", locator)
        if line.get("price"):
            price = line["price"]
            price["price_unit"] = normalize_unit(price.get("price_unit"))
            if price.get("reference_range"):
                if not isinstance(price["reference_range"], dict):
                    raise ValueError(f"Line {index}: reference_range must be an object or null")
                for field in ("min", "median", "max"):
                    numeric(price["reference_range"], field, locator)
    for index, section in enumerate(data.get("sections", [])):
        section.setdefault("sort_order", index)
    for area in data.get("areas", []):
        area.setdefault("name", area.get("id", ""))
    input = AnalysisInput.model_validate(data)
    for collection in (input.lines, input.sections, input.areas):
        ids = [item.id for item in collection]
        if len(ids) != len(set(ids)):
            raise ValueError("Internal IDs must be unique within each collection")
    input.input_hash = canonical_hash(input)
    return input


def from_json(path: str | Path) -> AnalysisInput:
    path = Path(path)
    with path.open(encoding="utf-8-sig") as handle:
        payload = json.load(handle, parse_float=Decimal)
    return from_data(payload, filename=path.name)
