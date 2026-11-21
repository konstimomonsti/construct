"""Generate ordinary tender files with labelled specification and pricing mutations."""

import argparse
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
            write_labels(path, f"clean.{ext}", label)


def write_labels(path, baseline, label):
    path.with_suffix(path.suffix + ".labels.json").write_text(json.dumps({
        "schema": "construct-eval-labels/1", "file": path.name, "suite": "catalogue",
        "backend": path.suffix[1:], "baseline": baseline, "labels": [label],
    }), encoding="utf-8")


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
                write_labels(path, f"precast-clean.{ext}", label)
            else:
                code = label["target"]["line_codes"][0]
                row = next(index for index, item in enumerate(items, 2) if item.code == code)
                locator = {"page": 1} if ext == "pdf" else {"table": 1, "row": row}
                write_labels(path, f"precast-clean.{ext}", {**label, "target": {**label["target"], "source_locator": locator}})



def generate_gutter(out):
    """Two descriptions of an external gutter, with and without a material conflict."""
    out.mkdir(parents=True, exist_ok=True)
    base = Item("01.0010", "Dachrinne Kupfer halbrund", 10, "m",
                detail="Hängedachrinne halbrund aus Kupfer, Zuschnitt 333 mm, einschließlich Rinnenhalter liefern und montieren.")
    for ext, writer in (("pdf", pdf_file), ("docx", word_file)):
        clean = out / f"gutter-clean.{ext}"
        writer(clean, [base], "Leistungsverzeichnis Dachentwässerung")
        write_labels(clean, clean.name, {"control": True, "expect": [], "layers": [3]})
        conflict = out / f"gutter-conflict.{ext}"
        writer(conflict, [replace(base, detail=base.detail.replace("Kupfer", "Titanzink"))],
               "Leistungsverzeichnis Dachentwässerung")
        locator = {"page": 1} if ext == "pdf" else {"table": 1, "row": 2}
        write_labels(conflict, clean.name, {
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
        pdf_file(out / f"{name}.pdf", [item], title)
        word_file(out / f"{name}.docx", [item], title)
        (out / f"{name}.json").write_text(json.dumps({
            "title": title, "positions": [{"id": "height-item", "oz": item.code, "short": short, "long": detail,
                                           "qty": item.quantity, "unit": item.unit}],
        }, ensure_ascii=False), encoding="utf-8")
        gaeb_writer.write_file({
            "bom": {"title": title},
            "sections": [{"id": "height-section", "code_parts": ["01"], "title": title}],
            "lines": [{"id": "height-item", "section_id": "height-section", "code_parts": ["01", "0010"],
                       "short_text": short, "long_text": detail, "quantity": item.quantity, "unit": item.unit}],
        }, out / f"{name}.X83")
        locators = {"pdf": {"page": 1}, "docx": {"table": 1, "row": 2}, "json": {"row": 1}, "X83": {"source_id": "height-item"}}
        for ext, locator in locators.items():
            label = {"control": not conflict, "layers": [1], "expect": []}
            if conflict:
                label.update(expect=["L1.TEXT.VALUE_CONFLICT"], match="line", target={
                    "line_codes": [item.code], "severity": "warning", "source_locator": locator,
                })
            baseline = "board-clean" if board else "height-clean"
            write_labels(out / f"{name}.{ext}", f"{baseline}.{ext}", label)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out", type=Path)
    suites = {"tabular": generate, "precast": generate_precast, "gutter": generate_gutter,
              "dimensions": generate_dimensions}
    parser.add_argument("--suite", choices=suites, default="tabular")
    args = parser.parse_args()
    suites[args.suite](args.out)
