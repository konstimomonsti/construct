"""Preview tender PDFs and legacy Excel workbooks as editable workspace lists."""

from hashlib import sha256
from pathlib import PurePath
from subprocess import TimeoutExpired
from typing import NamedTuple

from xlrd.biffh import XLRDError

from analysis import adapter
from analysis.contracts import AnalysisInput, SourceDocument
from tender_import.common import detect_format
from tender_import.ingest import parse_document


class ParsedDocument(NamedTuple):
    snapshots: list[AnalysisInput]
    warnings: list[str]


def read_document(filename: str, content: bytes) -> ParsedDocument:
    name = PurePath(filename.replace("\\", "/")).name
    suffix = PurePath(name).suffix.lower()
    kind = detect_format(name, content)
    if (suffix, kind) not in {(".pdf", "pdf"), (".xls", "xls")}:
        raise ValueError("Choose a tender PDF or a legacy .xls workbook.")
    if kind == "pdf" and not content.lstrip().startswith(b"%PDF-"):
        raise ValueError("The file is not a valid PDF.")
    try:
        result = parse_document(kind, content)
    except XLRDError as exc:
        raise ValueError("The file is not a readable Excel 97–2003 workbook.") from exc
    except TimeoutExpired as exc:
        raise ValueError("PDF extraction timed out. Try a smaller document.") from exc
    except OSError as exc:
        raise ValueError("PDF extraction is temporarily unavailable.") from exc
    source = SourceDocument(id=sha256(content).hexdigest(), filename=name, format=kind)
    sheets = sorted({r.payload["boq_index"] for r in result.records
                     if r.kind == "boq_header" and r.payload.get("boq_index") is not None})
    snapshots = [adapter.from_import(result, document=source, boq_index=index) for index in (sheets or [None])]
    warnings = list(dict.fromkeys(issue.get("detail") or issue["code"] for issue in result.issues))
    return ParsedDocument(snapshots, warnings)


def preview(filename: str, content: bytes) -> dict:
    snapshots, warnings = read_document(filename, content)
    positions = []
    tree = []
    for index, snapshot in enumerate(snapshots, 1):
        path_prefix = []
        target_tree = tree
        if len(snapshots) > 1:
            name = snapshot.bom.title or f"Sheet {index}"
            sheet = {"oz": f"S{index}", "label": name, "depth": 0, "children": []}
            tree.append(sheet)
            target_tree = sheet["children"]
            path_prefix = [{"oz": sheet["oz"], "label": name}]
        paths: dict[str, list] = {}
        nodes: dict[str, dict] = {}
        for section in snapshot.sections:
            parent_path = paths.get(section.parent_id, path_prefix)
            label = section.title or section.code or "Untitled section"
            code = section.code or section.id
            oz = f"S{index}.{code}" if path_prefix else code
            paths[section.id] = [*parent_path, {"oz": oz, "label": label}]
            node = {"oz": oz, "label": label, "depth": len(parent_path), "children": []}
            nodes[section.id] = node
            siblings = nodes[section.parent_id]["children"] if section.parent_id in nodes else target_tree
            siblings.append(node)
        for line in snapshot.lines:
            price = line.source_amounts.unit_price if line.source_amounts else None
            path = paths.get(line.section_id, path_prefix)
            positions.append({
                "id": line.id, "oz": line.code, "short": line.short_text, "long": line.long_text,
                "qty": float(line.quantity) if line.quantity is not None else 0,
                "quantityMissing": line.quantity is None,
                "unit": line.unit_raw or line.unit or "", "up": float(price) if price is not None else None,
                "lumpSum": line.pricing_basis == "lump_sum", "path": path,
                "totalRule": line.total_rule,
                "category": path[0]["label"] if path else "Import",
            })
    return {
        "title": (snapshots[0].bom.title if len(snapshots) == 1 else None) or PurePath(filename).stem,
        "currency": snapshots[0].project.currency or "EUR",
        "positions": positions, "tree": tree, "warnings": warnings,
    }
