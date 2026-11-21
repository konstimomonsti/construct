"""Generate ordinary tender files with labelled specification and pricing mutations."""

import argparse
import csv
from dataclasses import dataclass, replace
from decimal import Decimal
import json
from pathlib import Path

from docx import Document
from docx.shared import Inches
import reportlab
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import simpleSplit

from . import PRECAST_PATH, docio, gaeb_writer, ops, precast
from .labels import write_fixture_labels


@dataclass(frozen=True)
class Item:
    code: str
    short: str
    quantity: int | Decimal | None
    unit: str
    price: int = 10
    amount: int | None = None
    detail: str | None = None

    def cells(self):
        amount = self.amount if self.amount is not None else self.quantity * self.price if self.quantity is not None else None
        return (self.code, self.short, decimal(self.quantity, 3), self.unit, decimal(self.price), decimal(amount))


def decimal(value, places=2):
    return "" if value is None else format(Decimal(value), f".{places}f").replace(".", ",")


def pdf_file(path, items, title="Leistungsverzeichnis Innenausbau"):
    fonts = Path(reportlab.__file__).parent / "fonts"
    pdfmetrics.registerFont(TTFont("Fixture", str(fonts / "Vera.ttf")))
    pdfmetrics.registerFont(TTFont("FixtureBold", str(fonts / "VeraBd.ttf")))
    page = canvas.Canvas(str(path), pagesize=A4, invariant=1)
    page.setTitle(title)
    page.setKeywords("BOM assessment fixture")
    columns = (44, 100, 302, 356, 397, 478)

    def header():
        page.setFont("FixtureBold", 14)
        page.drawString(44, 785, title)
        page.setFont("Fixture", 9)
        names = ("OZ", "Leistungsbeschreibung", "Menge", "ME", "Einheitspreis", "Gesamtbetrag")
        for x, name in zip(columns, names):
            page.drawString(x, 741, name)
        page.line(44, 735, 552, 735)

    header()
    y = 716
    for item in items:
        code, short, qty, unit, rate, amount = item.cells()
        detail = simpleSplit(item.detail or "", "Fixture", 9, 438)
        if y - 14 - 12 * len(detail) < 46:
            page.showPage()
            header()
            y = 716
        page.drawString(columns[0], y, code)
        page.drawString(columns[1], y, short)
        for wording in detail:
            y -= 12
            page.drawString(columns[1], y, wording)
        if qty:
            for x, value in zip(columns[2:], (qty, unit or "...", rate, amount)):
                page.drawString(x, y - 14, value)
        y -= 37
    page.save()


def word_file(path, items, title="Leistungsverzeichnis Innenausbau"):
    document = Document()
    document.add_paragraph(title, "Title")
    section = document.sections[0]
    section.left_margin = section.right_margin = Inches(.6)
    table = document.add_table(rows=1, cols=6)
    table.autofit = False
    for index, width in enumerate((.75, 2.65, .65, .55, 1.1, 1.15)):
        table.columns[index].width = table.rows[0].cells[index].width = Inches(width)
    table.style = "Table Grid"
    headers = ("OZ", "Leistungsbeschreibung", "Menge", "ME", "Einheitspreis (EUR)", "Gesamtbetrag (EUR)")
    for cell, content in zip(table.rows[0].cells, headers):
        cell.text = content
    for item in items:
        cells = table.add_row().cells
        for cell, content in zip(cells, item.cells()):
            cell.text = content
        if item.detail:
            cells[1].add_paragraph(item.detail)
    document.save(path)


def generate(out):
    out.mkdir(parents=True, exist_ok=True)
    clean = [
        Item("01.0010", "Zementestrich schwimmend, 65 mm", 10, "m²"),
        Item("01.0020", "Randdämmstreifen aus Mineralwolle", 30, "m"),
        Item("01.0030", "Trittschalldämmung unter Estrich, 30 mm", 10, "m²"),
        Item("01.0040", "Vinyl als Bodenbelag verlegen", 10, "m²"),
        Item("01.0050", "Sockelleisten aus Holz montieren", 30, "m"),
        Item("02.0010", "Leerrohre für Signaltechnik liefern", 5, "m"),
    ]
    cases = [
        ("clean", clean, "", "", False),
        ("zero", [*clean[:-1], replace(clean[-1], quantity=0)], "L1.QTY.ZERO", "02.0010", False),
        ("blank-quantity", [*clean[:-1], replace(clean[-1], quantity=None)], "L1.QTY.MISSING", "02.0010", False),
        ("blank-unit", [*clean[:-1], replace(clean[-1], unit="")], "L1.UNIT.MISSING", "02.0010", False),
        ("written-amount", [*clean[:-1], replace(clean[-1], amount=85)], "L1.ARITH.LINE_AMOUNT", "02.0010", False),
        ("edge-insulation", [clean[0], *clean[2:]], "L2.FLOOR.SCREED_NEEDS_EDGE_INSULATION", "01.0010", True),
    ]
    for case, rows, rule, code, dependency in cases:
        for ext, write in (("pdf", pdf_file), ("docx", word_file)):
            path = out / f"{case}.{ext}"
            write(path, rows)
            label = {"control": not rule, "layers": [2 if dependency else 1], "expect": [rule] if rule else [],
                     "match": "dependency" if dependency else "line",
                     "target": {"trigger_codes" if dependency else "line_codes": [code]}}
            write_fixture_labels(path, f"clean.{ext}", label)


def generate_precast(out):
    """Render the two existing Layer 3 labels and their control as ordinary documents."""
    out.mkdir(parents=True, exist_ok=True)
    seed = docio.load(PRECAST_PATH)
    names = {"PRECAST-MISSING-SPEC", "PRECAST-REBAR-SCOPE"}
    cases = [("precast-clean", seed, {"control": True, "expect": [], "layers": [3]})]
    cases.extend((plan.id.lower(), ops.apply_to_doc(seed, plan.ops), plan.label)
                 for plan in precast.plans(seed) if plan.id in names)
    included = {"3.2.10", "3.2.40", "3.2.70", "3.2.75", "3.2.100", "3.2.120"}
    for name, bill, label in cases:
        items = [Item(line["code"], line["short_text"], line["quantity"], line["unit"], detail=line["long_text"])
                 for line in bill["lines"] if line["code"] in included]
        for ext, writer in (("pdf", pdf_file), ("docx", word_file)):
            path = out / f"{name}.{ext}"
            writer(path, items, "Leistungsverzeichnis Stahlbetonfertigteile")
            if label.get("control"):
                write_fixture_labels(path, f"precast-clean.{ext}", label)
            else:
                code = label["target"]["line_codes"][0]
                row = next(index for index, item in enumerate(items, 2) if item.code == code)
                locator = {"page": 1} if ext == "pdf" else {"table": 1, "row": row}
                write_fixture_labels(path, f"precast-clean.{ext}", {**label, "target": {**label["target"], "source_locator": locator}})



def generate_gutter(out):
    """Two descriptions of an external gutter, with and without a material conflict."""
    out.mkdir(parents=True, exist_ok=True)
    base = Item("01.0010", "Dachrinne Kupfer halbrund", 10, "m",
                detail="Hängedachrinne halbrund aus Kupfer, Zuschnitt 333 mm, einschließlich Rinnenhalter liefern und montieren.")
    for ext, writer in (("pdf", pdf_file), ("docx", word_file)):
        clean = out / f"gutter-clean.{ext}"
        writer(clean, [base], "Leistungsverzeichnis Dachentwässerung")
        write_fixture_labels(clean, clean.name, {"control": True, "expect": [], "layers": [3]})
        conflict = out / f"gutter-conflict.{ext}"
        writer(conflict, [replace(base, detail=base.detail.replace("Kupfer", "Titanzink"))],
               "Leistungsverzeichnis Dachentwässerung")
        locator = {"page": 1} if ext == "pdf" else {"table": 1, "row": 2}
        write_fixture_labels(conflict, clean.name, {
            "layers": [3], "expect": ["L3.TEXT.SHORT_LONG_CONTRADICTION"],
            "match": "line", "target": {"line_codes": [base.code], "severity": "warning", "source_locator": locator},
        })


def generate_dimensions(out):
    """Test directly attributed dimensions and unrelated or conditional values."""
    out.mkdir(parents=True, exist_ok=True)
    fence = "Bauzaun H = 2,0 m"
    wall = "GK-Ständerwand 12,5 mm beplankt"
    cases = [
        ("height-clean", fence, "Mobilen Bauzaun, Höhe 200 cm, mit Fußplatten liefern.", False),
        ("height-fence", fence, "Mobilen Bauzaun, Höhe 1,20 m, mit Fußplatten liefern.", True),
        ("height-guardrail", "Geländer, Höhe: 1100 mm", "Geländer H = 100 cm montieren.", True),
        ("height-post", fence, "Bauzaun mit Pfosten, Höhe 1,20 m für die Pfosten.", False),
        ("height-alternative", fence, "Bauzaun, Höhe 1,20 m oder 2,00 m.", False),
        ("height-range", fence, "Bauzaun, Höhe 1,20 m bis 2,00 m.", False),
        ("height-other-component", fence, "Geländer Höhe 1,20 m montieren.", False),
        ("board-conflict", wall,
         "Metallständerwand CW 75, beidseitig einlagig beplankt mit Gipsplatten Typ A, d = 15 mm.", True),
        ("board-clean", wall, "Metallständerwand beplankt mit Gipsplatten Typ A, Dicke 1,25 cm.", False),
        ("board-composite", wall, "Metallständerwand zweilagig beplankt mit Gipsplatten Typ A, d = 25 mm gesamt.", False),
    ]
    for name, short, detail, conflict in cases:
        board = name.startswith("board-")
        trade = "Trockenbau" if board else "Baustellensicherung"
        title = f"Leistungsverzeichnis {trade}"
        item = Item("01.0010", short, 10, "m²" if board else "m", detail=detail)
        locators = _write_text_case(out, name, title, item, "height")
        for ext, locator in locators.items():
            label = {"control": not conflict, "layers": [1], "expect": []}
            if conflict:
                label.update(expect=["L1.TEXT.VALUE_CONFLICT"], match="line", target={
                    "line_codes": [item.code], "severity": "warning", "source_locator": locator,
                })
            baseline = "board-clean" if board else "height-clean"
            write_fixture_labels(out / f"{name}.{ext}", f"{baseline}.{ext}", label)


def _write_text_case(out, name, title, item, prefix, *, additional=()):
    identifier = f"{prefix}-item"
    section_id = f"{prefix}-section"
    items = [item, *additional]
    identifiers = [identifier, *(f"{identifier}-{index}" for index in range(2, len(items) + 1))]
    pdf_file(out / f"{name}.pdf", items, title)
    word_file(out / f"{name}.docx", items, title)
    (out / f"{name}.json").write_text(json.dumps({
        "title": title, "positions": [
            {"id": row_id, "oz": row.code, "short": row.short, "long": row.detail,
             "qty": row.quantity, "unit": row.unit}
            for row_id, row in zip(identifiers, items)
        ],
    }, ensure_ascii=False), encoding="utf-8")
    gaeb_writer.write_file({
        "bom": {"title": title},
        "sections": [{"id": section_id, "code_parts": ["01"], "title": title}],
        "lines": [
            {"id": row_id, "section_id": section_id, "code_parts": row.code.split("."),
             "short_text": row.short, "long_text": row.detail, "quantity": row.quantity, "unit": row.unit}
            for row_id, row in zip(identifiers, items)
        ],
    }, out / f"{name}.X83")
    return {"pdf": {"page": 1}, "docx": {"table": 1, "row": 2}, "json": {"row": 1}, "X83": {"source_id": identifier}}


def _write_offer_tables(out, name, item, sheet_name="Entwässerung"):
    from openpyxl import Workbook
    from . import workbooks

    rows = [
        ("OZ", "Kurztext", "Menge", "ME", "EP", "GP", "Langtext"),
        (*item.cells(), item.detail),
    ]
    for ext, delimiter in (("csv", ";"), ("tsv", "\t")):
        with (out / f"{name}.{ext}").open("w", encoding="utf-8", newline="") as handle:
            csv.writer(handle, delimiter=delimiter).writerows(rows)
    book = Workbook()
    sheet = book.active
    sheet.title = sheet_name
    for row in rows:
        sheet.append(row)
    book.save(out / f"{name}.xlsx")
    legacy_item = workbooks.Item(item.code, item.short, item.quantity, item.unit, item.price,
                                 item.quantity * item.price, item.detail)
    workbooks.workbook(out / f"{name}.xls", [(sheet_name, [legacy_item], 0, 0)])
    return {"csv": {"row": 2}, "tsv": {"row": 2}, "xlsx": {"sheet": sheet.title, "row": 2},
            "xls": {"sheet": sheet.title, "row": 3}}


def generate_product_offer(out):
    """Keep the planned product constant while changing the separately offered SKU."""
    out.mkdir(parents=True, exist_ok=True)
    examples = Path(__file__).resolve().parents[3] / "data" / "examples"
    package = json.loads((examples / "drainage-variant-evidence.json").read_text(encoding="utf-8"))
    package["product_requirements"][0]["position_code"] = "01.0010"
    deficient, = package["declarations"]
    compliant = {**deficient, "product_code": "P160-B", "document": "Synthetic declaration P160-B",
                 "ring_stiffness_sn": 8,
                 "properties": {"material": {"value": "PVC-U"}, "outside_diameter": {"value": "16", "unit": "cm"}}}
    package["declarations"].append(compliant)
    (out / "product-evidence.json").write_text(json.dumps(package, indent=2), encoding="utf-8")

    detail = ("Mindestens SN 8.\nFabrikat der Planung:\nHersteller: Design Works; SKU: R160; oder gleichwertig.")
    rules = ("L1.PRODUCT.DRAINAGE_RING_STIFFNESS", "L1.PRODUCT.DIN_MATERIAL", "L1.PRODUCT.DECLARED_PROPERTY")
    for name, suffix, expected, severity in (
        ("offer-baseline", "\nAngebotenes Fabrikat:\nHersteller: Synthetic Works; SKU: P160-B", (), "warning"),
        ("offer-matching", "\nAngebotenes Fabrikat: Hersteller: Synthetic Works; Artikelnummer: P160-B", (), "warning"),
        ("offer-conflict", "\nAngebotenes Fabrikat:\nHersteller: Synthetic Works; SKU: P160-A", rules, "warning"),
        ("offer-reference-only", "", ("L1.PRODUCT.DECLARED_PROPERTY",), "info"),
    ):
        item = Item("01.0010", "PVC-U-Abwasserrohr nach DIN EN 1401-1", 10, "m", detail=detail + suffix)
        locators = _write_text_case(out, name, "Leistungsverzeichnis Entwässerung", item, "offer")
        locators.update(_write_offer_tables(out, name, item))
        if name == "offer-baseline":
            continue
        for ext, locator in locators.items():
            labels = [{"match": "line", "layers": [1], "expect": [rule], "target": {
                "line_codes": [item.code], "severity": severity, "source_locator": locator,
            }} for rule in expected]
            write_fixture_labels(out / f"{name}.{ext}", f"offer-baseline.{ext}",
                                 *(labels or [{"control": True, "layers": [1], "expect": []}]))


def generate_product_position(out):
    """Repeat the same code across two worksheets and qualify the governed position."""
    from openpyxl import Workbook
    from . import workbooks

    out.mkdir(parents=True, exist_ok=True)
    code = "01.0010"
    title = "Entwässerung"
    examples = Path(__file__).resolve().parents[3] / "data" / "examples"
    package = json.loads((examples / "drainage-variant-evidence.json").read_text(encoding="utf-8"))
    small, = package["declarations"]
    compliant = {**small, "product_code": "P160-B", "document": "Synthetic declaration P160-B",
                 "properties": {"outside_diameter": {"value": "16", "unit": "cm"}}}
    package["declarations"].append(compliant)
    requirement = package["product_requirements"][0]
    package["product_requirements"] = [
        {**requirement, "position_locator": {"sheet": title, "row": 3}},
        {**requirement, "locator": "index without a worksheet"},
        {**requirement, "locator": "outdated worksheet index", "position_locator": {"sheet": title, "row": 12}},
    ]
    (out / "product-evidence.json").write_text(json.dumps(package, indent=2), encoding="utf-8")

    def pipe(product):
        return workbooks.Item(code, "Abwasserrohr liefern", 10, "m", 10, 100,
                              f"Hersteller: Synthetic Works; SKU: {product}")

    rule = "L1.PRODUCT.DECLARED_PROPERTY"
    for name, sku, reorder in (("position-matching", "P160-B", False), ("position-conflict", "P160-A", False),
                               ("position-reordered", "P160-B", True)):
        sheets = [(title, pipe(sku)), ("Reserve", pipe("P160-A"))]
        if reorder:
            sheets.reverse()
        workbooks.workbook(out / f"{name}.xls", [(sheet, [item], 0, 0) for sheet, item in sheets])
        book = Workbook()
        book.remove(book.active)
        for sheet, item in sheets:
            tab = book.create_sheet(sheet)
            tab.append((sheet,))
            tab.append(("OZ", "Kurztext", "Menge", "ME", "EP", "GP", "Langtext"))
            tab.append((item.code, item.description, item.quantity, item.unit, item.rate, item.amount, item.detail))
        book.save(out / f"{name}.xlsx")
        for ext in ("xls", "xlsx"):
            if name == "position-conflict":
                labels = [{"match": "line", "layers": [1], "expect": [rule], "target": {
                    "line_codes": [code], "severity": "warning", "source_locator": {"sheet": title, "row": 3},
                }}]
            elif name == "position-matching":
                labels = [{"match": "bom", "layers": [1], "expect": [rule], "target": {"severity": "info", "reason": reason}}
                          for reason in ("position_ambiguous", "position_locator_mismatch")]
            else:
                labels = [{"control": True, "layers": [1], "expect": []}]
            write_fixture_labels(out / f"{name}.{ext}", f"position-matching.{ext}", *labels)


def generate_product_requirements(out):
    """Replay contradictions between two cited requirements across trades."""
    products = [
        ("01.0010", "Rohr für Grundstücksentwässerung", "m", "PIPE-125", "outside_diameter",
         {"value": "12.5", "unit": "cm"},
         ("at_least", "160", "mm", "at_most", "15", "cm"),
         ("at_least", "125", "mm", "at_most", "12,5", "cm")),
        ("01.0020", "Dämmplatte im Sockelbereich", "m²", "BOARD-425", "compressive_strength",
         {"value": "425", "unit": "kPa"},
         ("at_least", "450", "kPa", "at_most", "400", "kPa"),
         ("at_least", "400", "kPa", "at_most", "450", "kPa")),
        ("01.0030", "Revisionstür für Installationsschacht", "St", "DOOR-9010", "colour",
         {"value": "RAL 9010"},
         ("equal", "RAL 9010", None, "equal", "RAL 7016", None),
         ("equal", "RAL 9010", None, "equal", "ral 9010", None)),
    ]
    for conflict in (False, True):
        directory = out / ("conflict" if conflict else "compatible")
        directory.mkdir(parents=True, exist_ok=True)
        rows, declarations, requirements = [], [], []
        for code, heading, unit, sku, property_name, value, bad, good in products:
            rows.append(Item(code, heading, 10, unit, detail=f"Hersteller: Synthetic Works; SKU: {sku}"))
            declarations.append({"manufacturer": "Synthetic Works", "product_code": sku,
                                 "document": "Synthetic declaration " + sku, "revision": "A", "locator": "p. 2",
                                 "properties": {property_name: value}})
            first, minimum, min_unit, second, maximum, max_unit = bad if conflict else good
            for comparison, number, measure, document in (
                (first, minimum, min_unit, "Synthetic tender specification"),
                (second, maximum, max_unit, "Synthetic construction schedule"),
            ):
                requirements.append({"position_code": code, "property_name": property_name, "comparison": comparison,
                                     "required": {"value": number, "unit": measure}, "document": document,
                                     "locator": f"Record {code}"})
        package = {"schema": "billbuild.product-evidence.v1", "declarations": declarations,
                   "product_requirements": requirements}
        (directory / "product-evidence.json").write_text(json.dumps(package, indent=2), encoding="utf-8")

        title = "Synthetic coordination tender"
        locators = _write_text_case(directory, "requirements", title, rows[0], "requirements", additional=rows[1:])
        if not conflict:
            _write_text_case(directory, "baseline", title, rows[0], "requirements", additional=rows[1:])
        for ext in locators:
            labels = []
            for index, item in enumerate(rows, 1):
                locator = {
                    "pdf": {"page": 1}, "docx": {"table": 1, "row": index + 1}, "json": {"row": index},
                    "X83": {"source_id": "requirements-item" + (f"-{index}" if index > 1 else "")},
                }[ext]
                labels.append({"match": "line", "layers": [1], "expect": ["L1.PRODUCT.REQUIREMENT_CONFLICT"],
                               "target": {"line_codes": [item.code], "severity": "warning", "source_locator": locator}})
            write_fixture_labels(directory / f"requirements.{ext}",
                                 f"{'requirements' if conflict else 'baseline'}.{ext}",
                                 *(labels if conflict else [{"control": True, "layers": [1], "expect": []}]))


def generate_written_stiffness(out):
    """Test a written minimum against a contradictory attached upper bound."""
    out.mkdir(parents=True, exist_ok=True)
    package = {
        "schema": "billbuild.product-evidence.v1",
        "declarations": [{"manufacturer": "Synthetic Works", "product_code": "PIPE-4",
                          "document": "Synthetic declaration PIPE-4", "revision": "A", "locator": "p. 2",
                          "ring_stiffness_sn": 4}],
        "product_requirements": [{"position_code": "01.0010", "property_name": "ring_stiffness_sn",
                                  "comparison": "at_most", "required": {"value": "4", "unit": "SN"},
                                  "document": "Synthetic installation schedule", "locator": "Row 9"}],
    }
    (out / "product-evidence.json").write_text(json.dumps(package, indent=2), encoding="utf-8")
    for name, wording in (
        ("stiffness-compatible", "Mindestens SN 4."),
        ("stiffness-conflict", "Mindestens SN 8."),
        ("stiffness-conditional", "Sofern erforderlich, mindestens SN 8."),
    ):
        item = Item("01.0010", "PVC-U-Abwasserrohr DN 160", 10, "m",
                    detail=f"{wording}\nHersteller: Synthetic Works; SKU: PIPE-4")
        locators = _write_text_case(out, name, "Synthetic drainage tender", item, "stiffness")
        for ext, locator in locators.items():
            label = {"control": name != "stiffness-conflict", "layers": [1], "expect": []}
            if not label["control"]:
                label.update(match="line", expect=["L1.PRODUCT.REQUIREMENT_CONFLICT"], target={
                    "line_codes": [item.code], "severity": "warning", "source_locator": locator,
                })
            write_fixture_labels(out / f"{name}.{ext}", f"stiffness-compatible.{ext}", label)


def generate_action_spelling(out):
    """Replay parallel work actions and legitimate past-tense wording."""
    out.mkdir(parents=True, exist_ok=True)
    for name, wording, expected in (
        ("action-clean", "Schachtabdeckung liefern/aufsetzen", False),
        ("action-cover", "Schachtabdeckung liefern/aufsetzten", True),
        ("action-replace", "Bordstein ausbauen / ersetzten", True),
        ("action-preterite", "Abdeckung, die Monteure aufsetzten", False),
        ("action-product", "Fabrikat: Abdeckung liefern/aufsetzten", False),
    ):
        detail = "Abdeckung aus Edelstahl, 200 × 200 × 4 mm." if name == "action-product" else None
        item = Item("01.0010", wording, 10, "St", detail=detail)
        locators = _write_text_case(out, name, "Leistungsverzeichnis Montage", item, "action")
        locators.update(_write_offer_tables(out, name, item))
        for ext, locator in locators.items():
            label = {"control": not expected, "layers": [1], "expect": []}
            if expected:
                label.update(match="line", expect=["L1.TEXT.TYPO"], target={
                    "line_codes": [item.code], "severity": "info", "source_locator": locator,
                })
            baseline = "action-clean" if expected else name
            write_fixture_labels(out / f"{name}.{ext}", f"{baseline}.{ext}", label)


def generate_outline_duplicates(out):
    """Replay repeated Word outline codes with and without an explicit alternative."""
    out.mkdir(parents=True, exist_ok=True)
    shared = "1.2.90 – Zulage Deckbeschichtung [m]"
    for name, connector, repeat, severity in (
        ("outline-alternative", "oder", shared, "warning"),
        ("outline-additional", "mit", shared, "error"),
        ("outline-different", "oder", "1.2.90 – Andere Deckbeschichtung [m]", "error"),
    ):
        doc = Document()
        for paragraph in ("Rohrleitung", "1.2.10 – Stahlrohr liefern [m]", shared, connector,
                          "1.2.20 – Kunststoffrohr liefern [m]", repeat):
            doc.add_paragraph(paragraph)
        path = out / f"{name}.docx"
        doc.save(path)
        target = {"line_codes": ["1.2.90"], "severity": severity, "source_locator": {"paragraph": 6}}
        if severity == "warning":
            target["reason"] = "outline_alternatives"
        write_fixture_labels(path, path.name, {
            "layers": [1], "expect": ["L1.CODE.DUPLICATE"], "match": "line", "target": target,
        })


def generate_written_quantities(out):
    """Exercise direct quantities, hire products, and non-comparable descriptions."""
    out.mkdir(parents=True, exist_ok=True)
    for name, quantity, unit, detail, expected, baseline in (
        ("written-length-clean", 10, "m", "Abrechnungsmenge: 1000 cm.", False, "written-length-clean"),
        ("written-length-conflict", 10, "m", "Abrechnungsmenge: 12 m.", True, "written-length-clean"),
        ("written-hire-clean", 12, "mWo", "Positionsmenge = Produkt aus 3 m (Vorhaltemenge) mal 4 Wochen.", False,
         "written-hire-clean"),
        ("written-hire-conflict", 12, "mWo", "Positionsmenge = Produkt aus 3 m (Vorhaltemenge) mal 5 Wochen.", True,
         "written-hire-clean"),
        ("written-per-part", 10, "m", "Gesamtmenge: 7 m je Abschnitt.", False, "written-per-part"),
        ("written-part-dimension", 10, "m", "Bauteillänge 7 m.", False, "written-part-dimension"),
    ):
        heading = "Bauteil vorhalten" if "hire" in name else "Leitplanke montieren"
        item = Item("01.0010", heading, quantity, unit, detail=detail)
        locators = _write_text_case(out, name, "Leistungsverzeichnis Baustelle", item, "quantity")
        locators.update(_write_offer_tables(out, name, item))
        for ext, locator in locators.items():
            label = {"control": not expected, "layers": [1], "expect": []}
            if expected:
                label.update(match="line", expect=["L1.QTY.WRITTEN_CONFLICT"], target={
                    "line_codes": [item.code], "severity": "error", "source_locator": locator, "bidder_question": True,
                })
            write_fixture_labels(out / f"{name}.{ext}", f"{baseline}.{ext}", label)


def generate_underspecification(out):
    """Check an explicit missing rating and a fully specified door control."""
    out.mkdir(parents=True, exist_ok=True)
    for name, rating in (("property-stated", "T30"), ("property-open", "noch offen")):
        item = Item("01.0010", "Brandschutztür aus Stahl, 1000 × 2125 mm, RAL 9010", 1, "St",
                    detail=f"Feuerwiderstand: {rating}.\nInkl. Türschließer, Profilzylinder und Drückergarnitur.")
        for ext, locator in _write_text_case(out, name, "Leistungsverzeichnis Türen", item, "property").items():
            control = name == "property-stated"
            label = {"control": control, "layers": [1], "expect": []}
            if not control:
                label.update(match="line", expect=["L1.TEXT.SPEC_PLACEHOLDER"], target={
                    "line_codes": [item.code], "severity": "warning", "source_locator": locator, "bidder_question": True,
                })
            write_fixture_labels(out / f"{name}.{ext}", f"property-stated.{ext}", label)


def generate_fire_door_scope(out):
    """Replay silent rating omissions and comparable valid sources across the upload formats."""
    out.mkdir(parents=True, exist_ok=True)
    hardware = "Inkl. Türschließer, Profilzylinder und Drückergarnitur."
    door = "Brandschutztür aus Stahl, 1000 × 2125 mm, RAL 9010"
    for name, heading, requirement, missing in (
        ("fire-silent", door, "", True),
        ("fire-frame-only", door, "Zarge: T30.", True),
        ("fire-stated", door, "Feuerwiderstand: EI2 30-C5 Sa.", False),
        ("fire-scheduled", door, "Gemäß Türliste TL-01, Tür D-24.", False),
        ("fire-ordinary", door.replace("Brandschutztür", "Stahltür"), "", False),
        ("fire-existing", "Brandschutztür ausbauen, 1000 × 2125 mm", "", False),
    ):
        item = Item("01.0010", heading, 1, "St", detail="\n".join(part for part in (requirement, hardware) if part))
        locators = _write_text_case(out, name, "Leistungsverzeichnis Türen", item, "fire-door")
        locators.update(_write_offer_tables(out, name, item, "Türen"))
        for ext, locator in locators.items():
            label = {"control": not missing, "layers": [1], "expect": []}
            if missing:
                label.update(match="line", expect=["L1.TEXT.FIRE_DOOR_RATING_MISSING"], target={
                    "line_codes": [item.code], "severity": "warning", "source_locator": locator, "bidder_question": True,
                })
            baseline = "fire-stated" if missing else name
            write_fixture_labels(out / f"{name}.{ext}", f"{baseline}.{ext}", label)


def generate_fire_door_products(out):
    """Replay exact offered door classes and evidence gaps against the tender position."""
    out.mkdir(parents=True, exist_ok=True)
    manufacturer = "Synthetic Doors"
    package = {"schema": "billbuild.product-evidence.v1", "declarations": [
        {"manufacturer": manufacturer, "product_code": sku, "document": f"Synthetic declaration {sku}",
         "revision": "A", "locator": "page 2, classification table",
         "properties": {"fire_resistance_class": {"value": rating}}}
        for sku, rating in (
            ("D-24", "EI2 60 Sa C5"), ("D-25", "EI2 30-C5 Sa"), ("D-26", "T 60 RS"), ("D-27", "EI2 60-C5"),
        )
    ]}
    (out / "product-evidence.json").write_text(json.dumps(package, indent=2), encoding="utf-8")
    heading = "Brandschutztür aus Stahl, 1000 × 2125 mm, RAL 9010"
    hardware = "Inkl. Türschließer, Profilzylinder und Drückergarnitur."
    for name, sku, role, severity, reason in (
        ("door-product-matching", "D-24", "Angebotenes Fabrikat", None, None),
        ("door-product-lower", "D-25", "Angebotenes Fabrikat", "warning", None),
        ("door-product-other-family", "D-26", "Angebotenes Fabrikat", "info", "fire_class_basis_unverified"),
        ("door-product-no-smoke", "D-27", "Angebotenes Fabrikat", "info", "fire_class_basis_unverified"),
        ("door-product-no-declaration", "D-28", "Angebotenes Fabrikat", "info", "fire_class_unverified"),
        ("door-product-reference", "D-25", "Fabrikat der Planung", None, None),
    ):
        detail = f"Feuerwiderstand: EI2 60-C5 Sa.\n{hardware}\n{role}: Hersteller: {manufacturer}; SKU: {sku}"
        item = Item("01.0010", heading, 1, "St", detail=detail)
        locators = _write_text_case(out, name, "Leistungsverzeichnis Türen", item, "door-product")
        locators.update(_write_offer_tables(out, name, item, "Türen"))
        for ext, locator in locators.items():
            label = {"control": severity is None, "layers": [1], "expect": []}
            if severity:
                label.update(match="line", expect=["L1.PRODUCT.DECLARED_PROPERTY"], target={
                    "line_codes": [item.code], "severity": severity, "source_locator": locator, "reason": reason,
                })
            baseline = "door-product-matching" if severity else name
            write_fixture_labels(out / f"{name}.{ext}", f"{baseline}.{ext}", label)


def generate_fire_door_installation(out):
    """Replay declarations scoped to the supporting wall and its minimum thickness."""
    out.mkdir(parents=True, exist_ok=True)
    manufacturer = "Synthetic Doors"
    declarations = []
    for sku, rating, support, minimum in (
        ("W-100", "EI2 60-C5 Sa", "Trockenbauwand", "12.5"),
        ("W-101", "EI2 60-C5 Sa", "Stahlbetonwand", "10"),
        ("W-102", "EI2 60-C5 Sa", None, None),
        ("W-103", "EI2 30-C5 Sa", "Trockenbauwand", "12.5"),
        ("W-103", "EI2 60-C5 Sa", "Stahlbetonwand", "10"),
    ):
        properties = {"fire_resistance_class": {"value": rating}}
        if support:
            properties["fire_door_supporting_construction"] = {"value": support}
            properties["fire_door_min_wall_thickness"] = {"value": minimum, "unit": "cm"}
        declarations.append({"manufacturer": manufacturer, "product_code": sku,
                             "document": f"Synthetic declaration {sku}", "revision": "A",
                             "locator": f"page 2, {support or 'classification table'}", "properties": properties})
    package = {"schema": "billbuild.product-evidence.v1", "declarations": declarations}
    (out / "product-evidence.json").write_text(json.dumps(package, indent=2), encoding="utf-8")
    heading = "Brandschutztür aus Stahl, 1000 × 2125 mm, RAL 9010"
    for name, sku, support, thickness, severity, reason in (
        ("door-wall-fit", "W-100", "Trockenbauwand", "125 mm", None, None),
        ("door-wall-concrete-fit", "W-101", "Stahlbetonwand", "125 mm", None, None),
        ("door-wall-thin", "W-100", "Trockenbauwand", "100 mm", "warning", "fire_wall_below_minimum"),
        ("door-wall-approximate", "W-100", "Trockenbauwand", "ca. 125 mm", "info", "fire_wall_thickness_unverified"),
        ("door-wall-other-support", "W-101", "Trockenbauwand", "125 mm", "info", "fire_wall_scope_unverified"),
        ("door-wall-unknown-support", "W-102", "Trockenbauwand", "125 mm", "info", "fire_wall_scope_unverified"),
        ("door-wall-lower-class", "W-103", "Trockenbauwand", "125 mm", "warning", None),
    ):
        detail = (f"Feuerwiderstand: EI2 60-C5 Sa.\nWandmaterial: {support}.\nWanddicke: {thickness}.\n"
                  "Inkl. Türschließer, Profilzylinder und Drückergarnitur.\n"
                  f"Angebotenes Fabrikat: Hersteller: {manufacturer}; SKU: {sku}")
        item = Item("01.0010", heading, 1, "St", detail=detail)
        locators = _write_text_case(out, name, "Leistungsverzeichnis Türen", item, "door-wall")
        locators.update(_write_offer_tables(out, name, item, "Türen"))
        for ext, locator in locators.items():
            label = {"control": severity is None, "layers": [1], "expect": []}
            if severity:
                label.update(match="line", expect=["L1.PRODUCT.DECLARED_PROPERTY"], target={
                    "line_codes": [item.code], "severity": severity, "source_locator": locator, "reason": reason,
                })
            baseline = "door-wall-fit" if severity else name
            write_fixture_labels(out / f"{name}.{ext}", f"{baseline}.{ext}", label)


def generate_cable_designations(out):
    """Compare written cable configurations in power installation and roadworks examples."""
    out.mkdir(parents=True, exist_ok=True)
    for name, heading, detail, conflict in (
        ("cable-count", "Erdverbindungskabel NYY 7 x 1,5 mm²", "ErdverbindungskabelNYY 5 x 1,5 mm².", True),
        ("cable-section", "PVC-Mantelleitung NYM-J 3 x 1,5 mm²", "Kabeltyp: NYM-J 3 x 2,5 mm².", True),
        ("cable-concentric", "Energiekabel NYCWY 4 x 50/25 mm²", "Energiekabel NYCWY 4 × 50 SM/16 mm².", True),
        ("cable-suffix", "Energiekabel NYY-J 5 x 10 mm²", "Energiekabel NYY-O 5 x 10 mm².", True),
        ("cable-equivalent", "PVC-Mantelleitung NYM-J 3 x 1,5 mm²", "Kabeltyp: NYM-J 3 × 1.50 mm².", False),
        ("cable-connection", "Energiekabel NYCWY 4 x 50/25 mm²",
         "Energiekabel NYCWY 4 x 50/25 mm². Anschluss an Bestandskabel NYCWY 4 x 25/16 mm².", False),
        ("cable-alternative", "PVC-Mantelleitung NYM-J 3 x 1,5 mm²",
         "Kabeltyp: NYM-J 3 x 1,5 mm² oder NYM-J 3 x 2,5 mm² nach Kabelliste.", False),
    ):
        item = Item("01.0010", heading, 80, "m", detail=f"{detail}\nInkl. Kabelrinne und Kabelanschluss.")
        locators = _write_text_case(out, name, "Leistungsverzeichnis Elektroinstallation", item, "cable")
        locators.update(_write_offer_tables(out, name, item, "Elektro"))
        for ext, locator in locators.items():
            label = {"control": not conflict, "layers": [1], "expect": []}
            if conflict:
                label.update(match="line", expect=["L1.TEXT.VALUE_CONFLICT"], target={
                    "line_codes": [item.code], "severity": "warning", "source_locator": locator,
                    "bidder_question": True, "family": "cable_conductors",
                })
            baseline = "cable-equivalent" if conflict else name
            write_fixture_labels(out / f"{name}.{ext}", f"{baseline}.{ext}", label)


def generate_grade_scope(out):
    """Test concrete grade conflicts, legitimate component differences and unclear attribution."""
    out.mkdir(parents=True, exist_ok=True)
    short = "Betonbord Fundament C20/25"
    examples = (
        ("grade-clean", short, "Rückenstütze aus Beton C25/30.", None),
        ("grade-foundation", short, "Fundament aus Beton C25/30.", "warning"),
        ("grade-overlap", f"{short}. Rückenstütze C25/30.",
         "Fundament aus Beton C25/30. Rückenstütze aus Beton C25/30.", "warning"),
        ("grade-scope-review", short, "Bettung: 20 cm Normalbeton C25/30.", "info"),
        ("grade-alternative", short, "Fundament aus Beton C25/30 oder C20/25.", None),
    )
    for name, heading, detail, severity in examples:
        item = Item("01.0010", heading, 10, "m", detail=detail)
        for ext, locator in _write_text_case(out, name, "Leistungsverzeichnis Betonborde", item, "grade").items():
            label = {"control": severity is None, "layers": [1], "expect": []}
            if severity:
                label.update(expect=["L1.TEXT.VALUE_CONFLICT"], match="line", target={
                    "line_codes": [item.code], "severity": severity, "source_locator": locator,
                })
            write_fixture_labels(out / f"{name}.{ext}", f"grade-clean.{ext}", label)


def generate_exposure_scope(out):
    """Exercise source-linked DIN screening for several components in one position."""
    out.mkdir(parents=True, exist_ok=True)
    strength = "L1.DIN.EXPOSURE_STRENGTH"
    scope = "L1.DIN.EXPOSURE_SCOPE"
    examples = (
        ("exposure-clean", "Betonbord liefern", "Fundament C20/25 XC2. Bettung C35/45 XD3.", None),
        ("exposure-cross-clean", "Fundament C20/25. Bettung C35/45.",
         "Fundament: Expositionsklasse XC2. Bettung: Expositionsklasse XD3.", None),
        ("exposure-low", "Betonbord liefern", "Fundament C20/25 XD3. Bettung C35/45 XD3.", strength),
        ("exposure-cross-low", "Fundament C20/25. Bettung C35/45.",
         "Fundament: Expositionsklasse XD3. Bettung: Expositionsklasse XC2.", strength),
        ("exposure-unpaired", "Betonbord Fundament C20/25", "Bettung: Expositionsklasse XD3.", scope),
        ("exposure-alternative", "Betonbord liefern", "Fundament C35/45 oder C20/25 XD3.", scope),
    )
    for name, heading, detail, rule in examples:
        item = Item("01.0010", heading, 10, "m", detail=detail)
        for ext, locator in _write_text_case(out, name, "Leistungsverzeichnis Betonborde", item, "exposure").items():
            label = {"control": rule is None, "layers": [1], "expect": []}
            if rule:
                label.update(expect=[rule], match="line", target={
                    "line_codes": [item.code], "severity": "error" if rule == strength else "info",
                    "source_locator": locator,
                })
            write_fixture_labels(out / f"{name}.{ext}", f"exposure-clean.{ext}", label)



def generate_dependency_scope(out):
    """Replay explicit responsibility and references for a measured dependency."""
    out.mkdir(parents=True, exist_ok=True)
    examples = (
        ("dep-included", "Einschließlich Rohrdämmung.", False, (), False),
        ("dep-linked", "Rohrdämmung ist in Pos. 01.0020 enthalten.", False,
         (Item("01.0020", "Rohrdämmung aus Mineralwolle", 10, "m"),), False),
        ("dep-missing", "", "warning", (), False),
        ("dep-excluded", "Ausführung ohne Rohrdämmung.", "warning", (), True),
        ("dep-client", "Rohrdämmung wird bauseits geliefert.", "info", (), True),
        ("dep-separate", "Rohrdämmung in gesonderter Position.", "info", (), True),
        ("dep-dangling", "Rohrdämmung ist in Pos. 01.0090 enthalten.", "info", (), True),
    )
    for name, wording, severity, additional, has_quote in examples:
        detail = f"{wording} Druckprobe. Leitungsspülung. Wasserprobe.".strip()
        item = Item("01.0010", "TW-Rohrleitung DN 20", 10, "m", detail=detail)
        for ext, locator in _write_text_case(
            out, name, "Leistungsverzeichnis Trinkwasserinstallation", item, "dependency", additional=additional,
        ).items():
            label = {"control": not severity, "layers": [2], "expect": []}
            if severity:
                target = {"trigger_codes": [item.code], "severity": severity}
                if has_quote:
                    target["source_locator"] = locator
                label.update(expect=["L2.SANITARY.POTABLE_WATER_NEEDS_PIPE_INSULATION"],
                             match="dependency", target=target)
            write_fixture_labels(out / f"{name}.{ext}", f"dep-included.{ext}", label)



def generate_dotted(out):
    """Render non-consecutive short position codes, including a planted amount."""
    out.mkdir(parents=True, exist_ok=True)
    items = [
        Item(".41", "Halteplatte aus Stahl liefern", 12, "St"),
        Item(".47", "Abdeckung aus Stahl liefern", 8, "St"),
        Item(".87", "Tragschale aus Stahl liefern", 5, "m"),
    ]
    for name, positions in (
        ("dotted-clean", items),
        ("dotted-amount", [items[0], replace(items[1], amount=85), items[2]]),
    ):
        path = out / f"{name}.pdf"
        pdf_file(path, positions)
        clean = name == "dotted-clean"
        write_fixture_labels(path, "dotted-clean.pdf", {
            "control": clean, "layers": [1], "expect": [] if clean else ["L1.ARITH.LINE_AMOUNT"],
            "match": "line", "target": {"line_codes": [".47"], "source_locator": {"page": 1}},
        })



if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out", type=Path)
    suites = {"tabular": generate, "precast": generate_precast, "gutter": generate_gutter,
              "dimensions": generate_dimensions, "dotted": generate_dotted, "grade-scope": generate_grade_scope,
              "exposure-scope": generate_exposure_scope, "dependency-scope": generate_dependency_scope,
              "product-offer": generate_product_offer, "product-position": generate_product_position,
              "product-requirements": generate_product_requirements, "written-stiffness": generate_written_stiffness,
              "action-spelling": generate_action_spelling, "outline-duplicates": generate_outline_duplicates,
              "written-quantities": generate_written_quantities, "underspecification": generate_underspecification,
              "fire-door-scope": generate_fire_door_scope, "fire-door-products": generate_fire_door_products,
              "fire-door-installation": generate_fire_door_installation,
              "cable-designations": generate_cable_designations}
    parser.add_argument("--suite", choices=suites, default="tabular")
    args = parser.parse_args()
    suites[args.suite](args.out)
