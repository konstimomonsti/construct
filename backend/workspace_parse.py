"""Preview tender PDFs, Word documents and legacy Excel workbooks as editable workspace lists."""

from hashlib import sha256
from pathlib import PurePath
from subprocess import TimeoutExpired
from typing import NamedTuple
from zipfile import BadZipFile

from xlrd.biffh import XLRDError

from analysis import adapter
from analysis.contracts import AnalysisInput, Bom, Section, SourceDocument
from tender_import.common import detect_format
from tender_import.ingest import parse_document


class ParsedDocument(NamedTuple):
    snapshots: list[AnalysisInput]
    warnings: list[str]


def read_document(filename: str, content: bytes) -> ParsedDocument:
    name = PurePath(filename.replace("\\", "/")).name
    suffix = PurePath(name).suffix.lower()
    kind = detect_format(name, content)
    if (suffix, kind) not in {(".pdf", "pdf"), (".xls", "xls"), (".docx", "docx")}:
        raise ValueError("Choose a tender PDF or Word document, or a legacy .xls workbook.")
    if kind == "pdf" and not content.lstrip().startswith(b"%PDF-"):
        raise ValueError("The file is not a valid PDF.")
    try:
        result = parse_document(kind, content)
    except BadZipFile as exc:
        raise ValueError("The file is not a readable Word document.") from exc
    except XLRDError as exc:
        raise ValueError("The file is not a readable Excel 97–2003 workbook.") from exc
    except TimeoutExpired as exc:
        raise ValueError("PDF extraction timed out. Try a smaller document.") from exc
    except OSError as exc:
        raise ValueError("Document extraction is temporarily unavailable.") from exc
    if kind == "docx" and any(issue["code"] == "missing_word_body" for issue in result.issues):
        raise ValueError("The Word document body could not be read.")
    source = SourceDocument(id=sha256(content).hexdigest(), filename=name, format=kind)
    sheets = sorted({r.payload["boq_index"] for r in result.records
                     if r.kind == "boq_header" and r.payload.get("boq_index") is not None})
    snapshots = [adapter.from_import(result, document=source, boq_index=index) for index in (sheets or [None])]
    warnings = list(dict.fromkeys(issue.get("detail") or issue["code"] for issue in result.issues))
    return ParsedDocument(snapshots, warnings)


def _sheet_name(snapshot: AnalysisInput, index: int) -> str:
    first = next(iter(snapshot.lines), None)
    sheet = first.source_locator.get("sheet") if first else None
    return sheet or snapshot.bom.title or f"Sheet {index}"


def _section_oz(section: Section, sheet_id: str | None) -> str:
    code = section.code or section.id
    return f"{sheet_id}.{code}" if sheet_id else code


def original_document(filename: str, content: bytes) -> AnalysisInput:
    snapshots, _ = read_document(filename, content)
    if len(snapshots) == 1:
        return snapshots[0]

    sections, lines = [], []
    for index, sheet in enumerate(snapshots, 1):
        sheet_id = f"S{index}"
        # A printed net total belongs to its own sheet, so use it as that sheet's
        # root subtotal. A workbook-wide net total cannot be inferred from it.
        sections.append(Section(
            id=sheet_id, code=sheet_id, title=_sheet_name(sheet, index), sort_order=len(sections),
            stated_total=sheet.bom.stated_net_total, stated_total_locator=sheet.bom.stated_net_total_locator,
        ))
        section_ids = {section.id: _section_oz(section, sheet_id) for section in sheet.sections}
        for section in sheet.sections:
            sections.append(section.model_copy(update={
                "id": section_ids[section.id], "parent_id": section_ids.get(section.parent_id, sheet_id),
                "sort_order": len(sections),
            }))
        for line in sheet.lines:
            lines.append(line.model_copy(update={
                "section_id": section_ids.get(line.section_id, sheet_id), "sort_order": len(lines),
            }))
    workbook = snapshots[0].model_copy(update={
        "bom": Bom(title=PurePath(filename).stem), "sections": sections, "lines": lines,
    })
    return workbook.with_hash()


def preview(filename: str, content: bytes) -> dict:
    snapshots, warnings = read_document(filename, content)
    positions = []
    tree = []
    for index, snapshot in enumerate(snapshots, 1):
        sheet_id = None
        path_prefix = []
        target_tree = tree
        if len(snapshots) > 1:
            sheet_id = f"S{index}"
            sheet = {"oz": sheet_id, "label": _sheet_name(snapshot, index), "depth": 0, "children": []}
            tree.append(sheet)
            target_tree = sheet["children"]
            path_prefix = [{"oz": sheet_id, "label": sheet["label"]}]
        paths: dict[str, list] = {}
        nodes: dict[str, dict] = {}
        for section in snapshot.sections:
            parent_path = paths.get(section.parent_id, path_prefix)
            label = section.title or section.code or "Untitled section"
            oz = _section_oz(section, sheet_id)
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
                "unit": line.unit_raw or line.unit or "", "up": float(price) if price is not None else None,
                "lumpSum": line.pricing_basis == "lump_sum", "path": path,
                "category": path[0]["label"] if path else "Import",
            })
    return {
        "title": (snapshots[0].bom.title if len(snapshots) == 1 else None) or PurePath(filename).stem,
        "currency": snapshots[0].project.currency or "EUR",
        "positions": positions, "tree": tree, "warnings": warnings,
    }
