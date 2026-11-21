from io import BytesIO
import re
from zipfile import ZipFile

from .common import Result, checked_entries, decimal_text, german_decimal, local_name, parse_xml, read_member, xml_document, zip_metadata


def child(node, tag):
    return next((candidate for candidate in node if local_name(candidate) == tag), None)


def descendants(node, tag):
    return (candidate for candidate in node.iter() if local_name(candidate) == tag)


def text(node):
    if node is None:
        return None
    return " ".join(" ".join(node.itertext()).split()) or None


def gaeb_xml(data: bytes) -> Result:
    root = parse_xml(data)
    if local_name(root) != "GAEB":
        raise ValueError("XML document root is not GAEB")

    info = child(root, "GAEBInfo")
    project = child(root, "PrjInfo")
    award = child(root, "Award")
    result = Result(
        "gaeb_xml",
        version=text(child(info, "Version")) if info is not None else None,
        phase=text(child(award, "DP")) if award is not None else None,
    )
    result.metadata.update(
        namespace=root.nsmap.get(None),
        project_code=text(child(project, "NamePrj")) if project is not None else None,
        project_label=text(child(project, "LblPrj")) if project is not None else None,
        currency=text(child(project, "Cur")) if project is not None else None,
    )
    result.add("xml_document", {"part": "document"}, **xml_document(root))

    paths = root.getroottree()
    for boq_number, boq in enumerate(descendants(root, "BoQ"), 1):
        boq_info = child(boq, "BoQInfo")
        boq_code = text(child(boq_info, "Name")) if boq_info is not None else None
        boq_title = text(child(boq_info, "LblBoQ")) if boq_info is not None else None
        document_section = {"boq_index": boq_number, "boq_code": boq_code, "boq_title": boq_title}
        result.add("boq_header", {"xml_path": paths.getelementpath(boq)}, **document_section)
        net_total = stated_total(boq_info)
        if net_total is not None:
            result.add("summary", {"xml_path": paths.getelementpath(boq_info)}, **document_section, net_total=net_total)
        walk_gaeb_boq(boq, (), (), document_section, result)

    if not any(record.kind == "item" for record in result.records):
        result.warn("no_boq_items", {"part": "document"}, "No structured Item elements were found")
    return result


def stated_total(node, field: str = "Total") -> str | None:
    """An amount in <Totals> under a BoQInfo or BoQCtgy: Total (before discount) or TotAfterDisc."""
    totals = child(node, "Totals") if node is not None else None
    return decimal_text(text(child(totals, field))) if totals is not None else None


def walk_gaeb_boq(node, code_parts, section_paths, boq, result):
    tag = local_name(node)
    locator = {"xml_path": node.getroottree().getelementpath(node)}
    if tag == "BoQCtgy":
        part = node.get("RNoPart")
        code_parts = (*code_parts, part) if part is not None else code_parts
        section_paths = (*section_paths, locator["xml_path"])
        result.add(
            "section", locator, **boq, code_parts=list(code_parts), source_id=node.get("ID"),
            label=text(child(node, "LblTx")), parent_section=section_paths[-2] if len(section_paths) > 1 else None,
        )
        subtotal = stated_total(node)
        if subtotal is not None:
            result.add("subtotal", locator, **boq, code_parts=list(code_parts), reported_amount=subtotal,
                       discounted_amount=stated_total(node, "TotAfterDisc"),
                       lump_sum_amount=stated_total(node, "TotalLSUM"))
    elif tag in {"Item", "MarkupItem"}:
        # RNoIndex is the index letter or digit after the item number (0010 A); like GAEB 90, it is its own part.
        item_parts = (*code_parts, *(part for part in (node.get("RNoPart"), node.get("RNoIndex")) if part is not None))
        description = child(node, "Description")
        quantity_raw = text(child(node, "Qty"))
        quantity = decimal_text(quantity_raw)
        if quantity_raw is not None and quantity is None:
            result.warn("invalid_quantity", locator, f"Cannot decode quantity {quantity_raw!r}")
        flags = {key: text(child(node, key)) for key in ("LumpSumItem", "Provis", "UPBkdn", "AltItem", "RefDescr")}
        if tag == "MarkupItem":
            # A surcharge on other items: a percentage (Markup) of a base amount (ITMarkup), with no quantity or unit.
            flags.update(MarkupItem="Yes", MarkupType=text(child(node, "MarkupType")),
                         Markup=text(child(node, "Markup")), ITMarkup=text(child(node, "ITMarkup")))
        result.add(
            "item", locator, **boq, source_id=node.get("ID"), code=".".join(item_parts),
            code_parts=list(item_parts), section_path=section_paths[-1] if section_paths else None,
            quantity=quantity, quantity_raw=quantity_raw, unit=text(child(node, "QU")),
            short_description=text(next(descendants(description, "TextOutlTxt"), None)) if description is not None else None,
            long_description=text(next(descendants(description, "DetailTxt"), None)) if description is not None else None,
            unit_price=decimal_text(text(child(node, "UP"))),
            line_amount=decimal_text(text(child(node, "IT"))),
            flags=flags,
            references=[
                {"type": local_name(entry), "attributes": dict(entry.attrib), "value": text(entry)}
                for entry in node if local_name(entry) in {"RefRNo", "RefPerfNo", "RefDescr"}
            ],
        )
        # Nested descriptions, text complements, catalog metadata and rich text are preserved in xml_document.
        return
    elif tag == "Remark":
        result.add("note", locator, **boq, section_path=section_paths[-1] if section_paths else None, text=text(node))
    for nested in node:
        if isinstance(nested.tag, str):
            walk_gaeb_boq(nested, code_parts, section_paths, boq, result)


_WORD = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_WORD_ITEM = re.compile(r"^\s*(?:[-•]\s*)?(\d+(?:\.\d+)+)\s*[–—-]\s*(.*?)\s*\[([^\[\]]+)\]\s*$", re.S)


def word_text(para):
    segments = []
    for node in para.iter():
        if node.tag == _WORD + "t":
            segments.append(node.text or "")
        elif node.tag == _WORD + "tab":
            segments.append("\t")
        elif node.tag in {_WORD + "br", _WORD + "cr"}:
            segments.append("\n")
    return "".join(segments)


def docx(data: bytes) -> Result:
    result = Result("docx", "OOXML", needs_review=True)
    with ZipFile(BytesIO(data)) as archive:
        entries = checked_entries(archive)
        found_body = False
        result.metadata["parts"] = len(entries)
        for number, entry in enumerate(entries, 1):
            locator = {"part": entry.filename, "entry": number}
            if entry.is_dir():
                result.add("word_part", locator, **zip_metadata(entry))
                continue
            payload = read_member(archive, entry)
            info = zip_metadata(entry, payload)
            if entry.filename.endswith((".xml", ".rels")):
                try:
                    root = parse_xml(payload)
                    info["xml"] = xml_document(root)
                    if entry.filename == "word/document.xml":
                        found_body = True
                        extract_word_paragraphs(root, locator, result)
                        extract_workspace_tables(root, locator, result)
                except (ValueError, SyntaxError) as exc:
                    result.warn("unreadable_word_part", locator, str(exc))
            result.add("word_part", locator, **info)
        if not found_body:
            result.warn("missing_word_body", {"part": "word/document.xml"}, "The main Word body could not be decoded")
    return result


def extract_word_paragraphs(root, locator, result):
    context = None
    connector = None
    for index, para in enumerate(root.iter(_WORD + "p"), 1):
        phrase = word_text(para)
        path = {**locator, "paragraph": index, "xml_path": root.getroottree().getelementpath(para)}
        style = para.find(f"{_WORD}pPr/{_WORD}pStyle")
        style_id = style.get(_WORD + "val") if style is not None else None
        result.add("paragraph", path, text=phrase, style=style_id)
        match = _WORD_ITEM.fullmatch(phrase)
        if match:
            code, description, unit = match.groups()
            result.add("item_candidate", path, code=code, short_description=description,
                       unit=unit, quantity=None, group=context, relationship_hint=connector,
                       confidence="review")
        elif phrase.strip().casefold() in {"oder", "mit"}:
            connector = phrase.strip()
        elif phrase.strip() and phrase.strip() not in {"…", "..."}:
            context, connector = phrase.strip(), None


def extract_workspace_tables(root, locator, result):
    fields = ("Position", "Description", "Quantity", "Unit", "Rate", "Amount", "Total rule")
    for table in root.iter(_WORD + "tbl"):
        rows = table.findall(_WORD + "tr")
        if not rows or tuple(word_text(cell).strip() for cell in rows[0].findall(_WORD + "tc")) != fields:
            continue
        for row in rows[1:]:
            cells = [word_text(cell).strip() for cell in row.findall(_WORD + "tc")]
            if len(cells) != len(fields) or not cells[1]:
                continue
            code, description, qty, unit, price, amount, total_rule = cells
            short, _, detail = description.partition("\n")
            flags = {"unit_price_only": total_rule == "Unit price only", "alternative_item": total_rule == "Conditional"}
            path = row.getroottree().getelementpath(row)
            result.add("item_candidate", {**locator, "xml_path": path}, code=code or None,
                       short_description=short, long_description=detail or None, unit=unit or None,
                       quantity=german_decimal(qty), unit_price=german_decimal(price),
                       line_amount=german_decimal(amount), flags=flags, confidence="review")
