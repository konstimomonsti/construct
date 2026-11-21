"""Generate ordinary visual PDF and Word tenders with labelled mutations."""

from dataclasses import dataclass, replace
from decimal import Decimal
import json
from pathlib import Path
import sys

from docx import Document
from docx.shared import Inches
import reportlab
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


@dataclass(frozen=True)
class Item:
    code: str
    short: str
    quantity: int | None
    unit: str
    price: int = 10
    amount: int | None = None

    def cells(self):
        amount = self.amount if self.amount is not None else self.quantity * self.price if self.quantity is not None else None
        return (self.code, self.short, decimal(self.quantity, 3), self.unit, decimal(self.price), decimal(amount))


def decimal(value, places=2):
    return "" if value is None else format(Decimal(value), f".{places}f").replace(".", ",")


def pdf_file(path, items):
    fonts = Path(reportlab.__file__).parent / "fonts"
    pdfmetrics.registerFont(TTFont("Fixture", str(fonts / "Vera.ttf")))
    pdfmetrics.registerFont(TTFont("FixtureBold", str(fonts / "VeraBd.ttf")))
    page = canvas.Canvas(str(path), pagesize=A4, invariant=1)
    page.setTitle("Leistungsverzeichnis Innenausbau")
    page.setKeywords("BOM assessment fixture")
    page.setFont("FixtureBold", 14)
    page.drawString(44, 785, "Leistungsverzeichnis Innenausbau")
    page.setFont("Fixture", 9)
    columns = (44, 100, 302, 356, 397, 478)
    for x, title in zip(columns, ("OZ", "Leistungsbeschreibung", "Menge", "ME", "Einheitspreis", "Gesamtbetrag")):
        page.drawString(x, 741, title)
    page.line(44, 735, 552, 735)
    for row, item in enumerate(items):
        y = 716 - 37 * row
        code, short, qty, unit, rate, amount = item.cells()
        page.drawString(columns[0], y, code)
        page.drawString(columns[1], y, short)
        if qty:
            for x, value in zip(columns[2:], (qty, unit or "...", rate, amount)):
                page.drawString(x, y - 14, value)
    page.save()


def word_file(path, items):
    document = Document()
    document.add_paragraph("Leistungsverzeichnis Innenausbau", "Title")
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
        for cell, content in zip(table.add_row().cells, item.cells()):
            cell.text = content
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
            path.with_suffix(f".{ext}.labels.json").write_text(json.dumps({
                "schema": "construct-eval-labels/1", "file": path.name, "suite": "catalogue",
                "backend": ext, "baseline": f"clean.{ext}", "labels": [label],
            }), encoding="utf-8")


if __name__ == "__main__":
    generate(Path(sys.argv[1]))
