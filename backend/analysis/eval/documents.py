"""Generate ordinary visual PDF and Word tenders with labelled mutations."""

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

from . import PRECAST_PATH, docio, ops, precast


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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out", type=Path)
    suites = {"tabular": generate, "precast": generate_precast, "gutter": generate_gutter}
    parser.add_argument("--suite", choices=suites, default="tabular")
    args = parser.parse_args()
    suites[args.suite](args.out)
