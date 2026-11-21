from datetime import date
from decimal import Decimal, ROUND_HALF_UP, localcontext
from io import BytesIO
import json
import os
import re
from textwrap import wrap
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor
from lxml import etree
from pypdf import PdfWriter
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import LongTable, Paragraph, SimpleDocTemplate, Spacer, TableStyle

from tender_import.common import BOM_PDF_ATTACHMENT
from tender_import.legacy import _FIELDS


CENTS = Decimal("0.01")
LABELS = {"include": "Included", "conditional": "Conditional", "unit_price_only": "Unit price only"}
EXPORT_UNIT = {
    "ea": "St", "set": "Satz", "lump_sum": "psch", "week": "Wo", "month": "Mt",
    "year": "Jahr", "m·week": "mWo", "ea·week": "StWo", "m²·day": "m2d",
    "m²·week": "m2Wo", "m·day": "md",
}
FORMATS = {
    "pdf": ("pdf", "application/pdf"), "docx": ("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    "x83": ("x83", "application/xml"), "x83-31": ("x83", "application/xml"), "x82": ("x82", "application/xml"),
    "d83": ("d83", "application/octet-stream"), "d84": ("d84", "application/octet-stream"),
    "d86": ("d86", "application/octet-stream"), "zip": ("zip", "application/zip"),
}


def amount(line):
    rate = line["draft_unit_price"]
    if rate is None or line["total_rule"] == "unit_price_only":
        return None
    qty = Decimal(1) if line["pricing_basis"] == "lump_sum" else line["quantity"]
    if qty is None:
        return None
    with localcontext(prec=60):
        return (qty * rate).quantize(CENTS, rounding=ROUND_HALF_UP)


def figures(bom):
    lines = [line for line in bom["lines"] if line["total_rule"] == "include"]
    values = [amount(line) for line in lines]
    with localcontext(prec=60):
        return sum((value for value in values if value is not None), Decimal(0)), sum(value is None for value in values)


def number(value, comma=False):
    if value is None:
        return ""
    text = format(value, "f")
    return text.replace(".", ",") if comma else text


def description(line):
    title = line["short_description"]
    long = line.get("long_description")
    return title if not long or long.strip() == title.strip() else f"{title}\n{long}"


def detail_rows(bom):
    for line in bom["lines"]:
        yield [
            line.get("line_code") or "", description(line), number(line["quantity"], True),
            export_unit(line), number(line["draft_unit_price"], True), number(amount(line), True),
            LABELS[line["total_rule"]],
        ]


def totals_text(bom):
    total, missing = figures(bom)
    currency = bom["version"]["currency"]
    text = f"Priced subtotal {number(total, True)} {currency}"
    return f"{text} · {missing} included position(s) without an amount" if missing else text


def pdf_export(bom):
    out = BytesIO()
    base = os.environ.get("PDF_FONT_DIR", "/usr/share/fonts/truetype/dejavu").rstrip("/") + "/"
    pdfmetrics.registerFont(TTFont("BOM Sans", base + "DejaVuSans.ttf"))
    pdfmetrics.registerFont(TTFont("BOM Sans Bold", base + "DejaVuSans-Bold.ttf"))
    body_style = ParagraphStyle("Value", fontName="BOM Sans", fontSize=8, leading=11)
    strong_style = ParagraphStyle("Heading", fontName="BOM Sans Bold", fontSize=8, leading=11)
    head_style = ParagraphStyle("Title", fontName="BOM Sans Bold", fontSize=19, leading=24, textColor=colors.HexColor("#183830"))
    sub_style = ParagraphStyle("Subtitle", fontName="BOM Sans", fontSize=9, leading=13)

    def p(text, style=body_style):
        return Paragraph(escape(text).replace("\n", "<br/>"), style)

    currency = bom["version"]["currency"]
    data = [[p(value, strong_style) for value in
             ("Position", "Description", "Qty", "Unit", f"Rate ({currency})", f"Amount ({currency})", "Total rule")]]
    for row in detail_rows(bom):
        detail = p(row[1])
        numbers = [p(value) for value in row[2:]]
        position = p(row[0])
        while detail.wrap(198, 570)[1] > 570:
            first, detail = detail.split(198, 570)
            data.append([position, first, *numbers])
            position = p("")
            numbers = [p("") for _ in numbers]
        data.append([position, detail, *numbers])
    table = LongTable(data, colWidths=[50, 210, 40, 35, 58, 65, 66], repeatRows=1)
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"), ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e6f2ec")),
        ("LINEBELOW", (0, 0), (-1, 0), .8, colors.HexColor("#b4cfc2")),
        ("LINEBELOW", (0, 1), (-1, -1), .32, colors.HexColor("#dbe7e1")),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    doc = SimpleDocTemplate(out, pagesize=A4, leftMargin=30, rightMargin=30, topMargin=30, bottomMargin=38)
    version = bom["version"]
    elements = [
        p("Bill of materials", head_style), p(version["title"], sub_style),
        p(f'{version["project_name"]} · Draft export · {date.today().isoformat()} · {currency}', sub_style),
        p(totals_text(bom), sub_style), Spacer(1, 13), table,
    ]
    if version.get("scope_notes"):
        elements.extend([Spacer(1, 15), p("Scope notes", strong_style), p(version["scope_notes"])])

    def footer(canvas, current_doc):
        canvas.setFont("BOM Sans", 8)
        canvas.setFillColor(colors.HexColor("#49645b"))
        canvas.drawString(31, 20, "BOM Workspace")
        canvas.drawRightString(A4[0] - 31, 20, str(current_doc.page))

    doc.build(elements, onFirstPage=footer, onLaterPages=footer)
    fields = ("line_code", "short_description", "long_description", "quantity", "unit_code",
              "draft_unit_price", "pricing_basis", "total_rule")
    embedded = {"currency": currency, "lines": [
        {**{field: line.get(field) for field in fields}, "line_amount": amount(line)} for line in bom["lines"]
    ]}
    attachment = json.dumps(embedded, default=str, ensure_ascii=False).encode("utf-8")
    if len(attachment) > 4 * 1024 * 1024:
        return out.getvalue()
    out.seek(0)
    writer = PdfWriter(clone_from=out)
    writer.add_attachment(BOM_PDF_ATTACHMENT, attachment)
    packaged = BytesIO()
    writer.write(packaged)
    return packaged.getvalue()


def word_export(bom):
    doc = Document()
    doc.styles["Title"].font.color.rgb = RGBColor.from_string("183830")
    doc.add_paragraph("Bill of Materials", style="Title")
    version = bom["version"]
    doc.add_paragraph(version["title"])
    doc.add_paragraph(f'{version["project_name"]} · Draft export · {date.today().isoformat()} · {version["currency"]}')
    doc.add_paragraph(totals_text(bom))
    section = doc.sections[0]
    section.left_margin = section.right_margin = Inches(.60)
    section.top_margin = section.bottom_margin = Inches(.65)
    doc.styles["Normal"].font.size = Pt(9)
    table = doc.add_table(rows=1, cols=7)
    table.style = "Table Grid"
    table.autofit = False
    widths = [0.70, 2.43, .72, .53, .85, .86, 1.12]
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        line = OxmlElement(f"w:{edge}")
        line.set(qn("w:val"), "single")
        line.set(qn("w:sz"), "4")
        line.set(qn("w:color"), "D9D9D9")
        borders.append(line)
    table._tbl.tblPr.append(borders)
    for column, width in zip(table.columns, widths):
        column.width = Inches(width)
    head = table.rows[0]
    head._tr.get_or_add_trPr().append(OxmlElement("w:tblHeader"))
    for cell, width, value in zip(head.cells, widths,
                                  ("Position", "Description", "Quantity", "Unit", "Rate", "Amount", "Total rule")):
        cell.width = Inches(width)
        run = cell.paragraphs[0].add_run(value)
        run.bold = True
        run.font.color.rgb = RGBColor.from_string("183830")
        shade = OxmlElement("w:shd")
        shade.set(qn("w:fill"), "E6F2EC")
        cell._tc.get_or_add_tcPr().append(shade)
    for values in detail_rows(bom):
        cells = table.add_row().cells
        for cell, value, width in zip(cells, values, widths):
            cell.width = Inches(width)
            cell.text = value
    if version.get("scope_notes"):
        doc.add_heading("Scope Notes", level=1)
        doc.add_paragraph(version["scope_notes"])
    out = BytesIO()
    doc.save(out)
    return out.getvalue()


def number_layout(lines, legacy=False):
    paths = []
    for line in lines:
        code = (line["line_code"] or "").strip(". ")
        if not re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", code):
            raise ValueError(f'GAEB export needs a numeric position code. Review position {code or "(blank)"}.')
        paths.append(tuple(code.split(".")))
    if not paths or len({len(parts) for parts in paths}) != 1:
        raise ValueError("GAEB export needs a consistent position code depth. Review the position numbers.")
    if len({tuple(int(part) for part in path) for path in paths}) != len(paths):
        raise ValueError("GAEB export needs unique position codes.")
    widths = [max(len(path[level]) for path in paths) for level in range(len(paths[0]))]
    if sum(widths) > (8 if legacy else 14) or len(widths) > 5:
        raise ValueError("The position codes exceed the width of the selected GAEB format.")
    if legacy:
        widths[-1] += 8 - sum(widths)
    return paths, widths


def export_unit(line):
    return EXPORT_UNIT.get(line.get("unit_code"), line.get("unit_code") or "")


def xml_export(bom, phase, version):
    namespace = (f"http://www.gaeb.de/GAEB_DA_XML/DA{phase}/3.2" if version == "3.2"
                 else "http://www.gaeb.de/GAEB_DA_XML/200407")
    root = etree.Element(f"{{{namespace}}}GAEB", nsmap={None: namespace})
    paths, widths = number_layout(bom["lines"])
    header = bom["version"]

    def add(parent, name, value=None, **attributes):
        node = etree.SubElement(parent, f"{{{namespace}}}{name}", attrib=attributes)
        if value is not None:
            node.text = str(value)
        return node

    def rich(node, value):
        for paragraph in (value.splitlines() or [""]):
            add(add(node, "p"), "span", paragraph)

    def add_text(parent, short, long):
        complete = add(add(parent, "Description"), "CompleteText")
        rich(add(add(complete, "DetailTxt"), "Text"), long or short)
        outline = add(add(complete, "OutlineText"), "OutlTxt")
        rich(add(outline, "TextOutlTxt"), short)

    info = add(root, "GAEBInfo")
    add(info, "Version", version)
    add(info, "VersDate", "2013-10" if version == "3.2" else "2009-12")
    add(info, "Date", date.today().isoformat())
    add(info, "ProgSystem", "BOM Workspace")
    project = add(root, "PrjInfo")
    add(project, "NamePrj", header["project_name"][:60])
    add(project, "Cur", header["currency"])
    award = add(root, "Award")
    add(award, "DP", phase)
    boq = add(award, "BoQ", ID="BOM")
    boq_info = add(boq, "BoQInfo")
    add(boq_info, "Name", "BOM")
    add(boq_info, "LblBoQ", header["title"][:60])
    add(boq_info, "OutlCompl", "AllTxt")
    for level, width in enumerate(widths):
        breakdown = add(boq_info, "BoQBkdn")
        add(breakdown, "Type", "Item" if level == len(widths) - 1 else "BoQLevel")
        add(breakdown, "Length", width)
        add(breakdown, "Num", "Yes")
    add(boq_info, "NoUPComps", 0)

    section_labels = {str(s["display_code"] or "").strip(". "): s["title"] for s in bom.get("sections", [])}
    root_body = add(boq, "BoQBody")
    if header.get("scope_notes"):
        add_text(add(root_body, "Remark", ID="Notes"), "Scope notes", header["scope_notes"])
    bodies = {(): root_body}
    lists = {}
    group = {}
    for line in bom["lines"]:
        base = line["alternative_for_line_id"]
        if base:
            ids = group.setdefault(base, {})
            ids[line["id"]] = len(ids) + 1
    alternatives = {line_id: (index, position) for index, (base, options) in enumerate(group.items(), 1)
                    for line_id, position in ((base, 0), *options.items())}
    for index, (path, line) in enumerate(zip(paths, bom["lines"]), 1):
        for depth in range(1, len(path)):
            prefix = path[:depth]
            if prefix in bodies:
                continue
            chapter = add(bodies[prefix[:-1]], "BoQCtgy", ID=f"S{len(bodies)}", RNoPart=prefix[-1])
            label = section_labels.get(".".join(prefix)) or (line.get("section") if depth == len(path) - 1 else None)
            rich(add(chapter, "LblTx"), label or ".".join(prefix))
            bodies[prefix] = add(chapter, "BoQBody")
        prefix = path[:-1]
        if prefix not in lists:
            lists[prefix] = add(bodies[prefix], "Itemlist")
        item = add(lists[prefix], "Item", ID=f"P{index}", RNoPart=path[-1])
        if line["id"] in alternatives:
            option_group, option_no = alternatives[line["id"]]
            add(item, "ALNGroupNo", option_group)
            add(item, "ALNSerNo", option_no)
        elif line["total_rule"] != "include":
            add(item, "Provis", "WithoutTotal")
        if line["pricing_basis"] == "lump_sum":
            add(item, "LumpSumItem", "Yes")
        qty = line["quantity"]
        if qty is None:
            add(item, "QtyTBD", "Yes")
        else:
            add(item, "Qty", exact_number(qty, 3, 11, line["line_code"]))
        unit = export_unit(line) or ("psch" if line["pricing_basis"] == "lump_sum" else "")
        if len(unit) > 4 or (phase == "83" and not unit):
            raise ValueError(f'Enter a GAEB-compatible unit (up to four characters) at {line["line_code"]}.')
        if unit:
            add(item, "QU", unit)
        if phase == "82" and line["draft_unit_price"] is not None:
            add(item, "UP", exact_number(line["draft_unit_price"], 3, 13, line["line_code"]))
            total = amount(line)
            if line["total_rule"] == "include" and total is not None:
                add(item, "IT", exact_number(total, 2, 13, line["line_code"]))
        add_text(item, line["short_description"], line.get("long_description"))
    return etree.tostring(root, encoding="UTF-8", xml_declaration=True, pretty_print=True)


def exact_number(value, scale, digits, code):
    encoded = value.scaleb(scale)
    if not value.is_finite() or encoded != encoded.to_integral_value() or abs(encoded) >= 10 ** digits:
        raise ValueError(f"The value on position {code} exceeds the precision or width of the GAEB format.")
    return format(value.normalize(), "f")


def legacy_export(bom, phase):
    paths, widths = number_layout(bom["lines"], legacy=True)
    header = bom["version"]
    rows = []
    mask = "".join(str(i + 1) * width for i, width in enumerate(widths[:-1])) + "P" * widths[-1] + "I"
    day = date.today().strftime("%d.%m.%y")
    section_labels = {str(s["display_code"] or "").strip(". "): s["title"] for s in bom.get("sections", [])}

    def legacy_text(value):
        return (value or "").replace("×", "x").replace("–", "-").replace("—", "-").replace("’", "'").replace("\t", " ")

    def record(kind, **fields):
        if len(rows) >= 999999:
            raise ValueError("Legacy GAEB exceeded the maximum record count.")
        row = list(kind.ljust(74) + f"{len(rows) + 1:06d}")
        for name, value in fields.items():
            start, end = _FIELDS[kind][name]
            if len(value) > end - start:
                raise ValueError(f"The value for {name} does not fit in a legacy GAEB record.")
            row[start:end] = value.ljust(end - start)
        try:
            rows.append("".join(row).encode("cp850"))
        except UnicodeEncodeError as error:
            raise ValueError(f'Legacy GAEB cannot encode {error.object[error.start:error.end]!r}. Use GAEB XML for this text.') from error

    def numeric(value, scale, width, code):
        if value is None:
            return ""
        exact_number(value, scale, width, code)
        sign = "-" if value < 0 else ""
        digits = str(abs(int(value.scaleb(scale))))
        if len(digits) + len(sign) > width:
            raise ValueError(f"Position {code} exceeds the legacy GAEB field width.")
        return sign + digits.zfill(width - len(sign))

    def order_number(parts):
        return "".join(part.rjust(width) for part, width in zip(parts, widths)).ljust(9)

    record("00", phase=phase, exchange_flag="K" if phase == "84" else "L",
           reference=legacy_text(header["title"].replace("\n", " "))[:48],
           number_mask=mask, edition="90")
    record("01", title=legacy_text(header["title"].replace("\n", " "))[:40], lv_date=day)
    record("02", project_text=legacy_text(header["project_name"].replace("\n", " "))[:72])
    record("08", currency_code=header["currency"], currency_label=header["currency"])
    if header.get("scope_notes") and phase != "84":
        record("20")
        for para in legacy_text(header["scope_notes"]).splitlines():
            for piece in wrap(para, 69, replace_whitespace=False) or [""]:
                record("26", control="   ", text=piece)
    previous = ()
    for path, line in zip(paths, bom["lines"]):
        code = line["line_code"]
        unit = legacy_text(export_unit(line)).replace("²", "2").replace("³", "3")
        if len(unit) > 4:
            raise ValueError(f"Use a legacy GAEB unit up to four characters at {code}.")
        prefix = path[:-1]
        if phase != "84":
            common = next((i for i, (a, b) in enumerate(zip(previous, prefix)) if a != b), min(len(previous), len(prefix)))
            for depth in range(len(previous), common, -1):
                record("31", number=order_number(previous[:depth]))
            for depth in range(common + 1, len(prefix) + 1):
                label = section_labels.get(".".join(prefix[:depth])) or ".".join(prefix[:depth])
                record("11", number=order_number(prefix[:depth]), kind_flag="N")
                record("12", text=legacy_text(label.replace("\n", " "))[:72])
            record("21", number=order_number(path), position_type="A" if line["alternative_for_line_id"] else "N",
                   provisional_flag="E" if line["total_rule"] != "include" else "N",
                   extra_type_flag="L" if line["pricing_basis"] == "lump_sum" else "N",
                   quantity=numeric(line["quantity"], 3, 11, code), unit=unit)
        if phase in {"84", "86"}:
            record("23", number=order_number(path), unit_price=numeric(line["draft_unit_price"], 3, 11, code),
                   quantity=numeric(line["quantity"], 3, 11, code),
                   line_amount=numeric(amount(line) if line["total_rule"] == "include" else None, 2, 12, code))
        if phase != "84":
            for piece in wrap(legacy_text(line["short_description"]).replace("\n", " "), 72):
                record("25", text=piece)
            if line.get("long_description"):
                for para in legacy_text(line["long_description"]).splitlines():
                    for piece in wrap(para, 69, replace_whitespace=False) or [""]:
                        record("26", control="   ", text=piece)
        previous = prefix
    if phase != "84":
        for depth in range(len(previous), 0, -1):
            record("31", number=order_number(previous[:depth]))
    total, _ = figures(bom)
    record("99", net_total=numeric(total, 2, 12, "total") if phase != "83" else "",
           position_count=str(len(bom["lines"])).zfill(5))
    return b"\r\n".join(rows) + b"\r\n"


def export(bom, kind):
    if kind not in FORMATS:
        raise ValueError("Select an export format.")
    if not bom["lines"]:
        raise ValueError("This draft has no positions to export.")
    ext, content_type = FORMATS[kind]
    filename = f'BOM-{str(bom["version"]["id"])[:8]}.{ext}'
    if kind == "pdf":
        data = pdf_export(bom)
    elif kind == "docx":
        data = word_export(bom)
    elif kind.startswith("x"):
        data = xml_export(bom, kind[1:3], "3.1" if kind.endswith("-31") else "3.2")
    elif kind.startswith("d"):
        data = legacy_export(bom, kind[1:])
    else:
        out = BytesIO()
        with ZipFile(out, "w", ZIP_DEFLATED) as bundle:
            for format_id in ("pdf", "docx"):
                name, _, content = export(bom, format_id)
                bundle.writestr(name, content)
        data = out.getvalue()
    return filename, content_type, data
