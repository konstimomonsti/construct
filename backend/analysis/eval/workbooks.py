"""Generate labelled binary .xls workbook fixtures (requires xlwt)."""

import argparse
from dataclasses import dataclass, replace
from pathlib import Path

import xlwt

from .labels import write_fixture_labels


@dataclass(frozen=True)
class Item:
    code: str
    description: str
    quantity: int | None
    unit: str
    rate: int
    amount: int
    detail: str | None = None


def workbook(path, sheets):
    book = xlwt.Workbook()
    heading = xlwt.easyxf("font: bold on")
    money = xlwt.easyxf(num_format_str="0.00")
    for name, positions, subtotal_delta, net_delta in sheets:
        sheet = book.add_sheet(name)
        columns = ("OZ", "Kurztext", "Menge", "ME", "EP (EUR)", "GP (EUR)", "Langtext")
        for col, value in enumerate(columns):
            sheet.write(0, col, value, heading)
            sheet.col(col).width = 256 * (48 if col in {1, 6} else 15)
        sheet.write(1, 0, "01", heading)
        sheet.write(1, 1, name, heading)
        for row, item in enumerate(positions, 2):
            for col, value in enumerate((item.code, item.description, item.quantity, item.unit, item.rate, item.amount, item.detail)):
                if value is not None:
                    sheet.write(row, col, value, money if col in {4, 5} else xlwt.Style.default_style)
        total = sum(item.amount for item in positions)
        summary = len(positions) + 2
        sheet.write(summary, 1, "Summe 01", heading)
        sheet.write(summary, 5, total + subtotal_delta, money)
        sheet.write(summary + 1, 1, "Angebotssumme netto", heading)
        sheet.write(summary + 1, 5, total + net_delta, money)
    book.save(str(path))


def generate(out):
    out.mkdir(parents=True, exist_ok=True)
    power = [
        Item("01.0010", "Leerrohre für Signaltechnik liefern", 5, "m", 10, 50),
        Item("01.0020", "Abdeckfolie für den Werkbereich verlegen", 4, "m²", 5, 20),
    ]
    floor = [
        Item("01.0010", "Zementestrich schwimmend, 65 mm", 10, "m²", 12, 120),
        Item("01.0020", "Randdämmstreifen aus Mineralwolle", 30, "m", 2, 60),
        Item("01.0030", "Trittschalldämmung unter Estrich, 30 mm", 10, "m²", 5, 50),
        Item("01.0040", "Vinyl als Bodenbelag verlegen", 10, "m²", 10, 100),
        Item("01.0050", "Sockelleisten aus Holz montieren", 30, "m", 2, 60),
    ]

    def electricity(positions=power, subtotal=0, net=0):
        return ("Elektro", positions, subtotal, net)

    def flooring(positions=floor, subtotal=0, net=0):
        return ("Boden", positions, subtotal, net)

    def write(name, sheets, rule=None, target=None, match="line", baseline="clean"):
        path = out / f"{name}.xls"
        workbook(path, sheets)
        write_fixture_labels(path, f"{baseline}.xls", {
            "control": rule is None, "expect": [rule] if rule else [], "match": match,
            "target": target or {}, "layers": [2 if match == "dependency" else 1],
        })

    def position(code, sheet, row):
        return {"line_codes": [code], "source_locator": {"sheet": sheet, "row": row}}

    write("clean", [electricity(), flooring()])
    write("reordered-sheets", [flooring(), electricity()])
    write("amount", [electricity(), flooring([replace(floor[0], amount=140), *floor[1:]])],
          "L1.ARITH.LINE_AMOUNT", position("01.0010", "Boden", 3))
    write("subtotal", [electricity(), flooring(subtotal=20)], "L1.ARITH.SECTION_TOTAL", {
        "section_codes": ["01"], "source_locator": {"sheet": "Boden", "row": 8},
    }, "section")
    write("sheet-total", [electricity(net=20), flooring()], "L1.ARITH.SECTION_TOTAL", {
        "section_codes": ["S1"], "source_locator": {"sheet": "Elektro", "row": 6},
    }, "section")
    write("missing-quantity", [electricity([replace(power[0], quantity=None), power[1]]), flooring()],
          "L1.QTY.MISSING", position("01.0010", "Elektro", 3))
    write("missing-unit", [electricity([replace(power[0], unit=""), power[1]]), flooring()],
          "L1.UNIT.MISSING", position("01.0010", "Elektro", 3))
    write("duplicate-in-sheet", [electricity([power[0], replace(power[1], code=power[0].code)]), flooring()],
          "L1.CODE.DUPLICATE", position("01.0010", "Elektro", 4))
    write("missing-edge", [electricity(), flooring([floor[0], *floor[2:]])],
          "L2.FLOOR.SCREED_NEEDS_EDGE_INSULATION", {"trigger_codes": [floor[0].code]}, "dependency")
    elsewhere = replace(floor[1], code="01.0030")
    write("edge-on-other-sheet", [electricity([*power, elsewhere]), flooring([floor[0], *floor[2:]])],
          "L2.FLOOR.SCREED_NEEDS_EDGE_INSULATION", {"trigger_codes": [floor[0].code]}, "dependency")
    write("single-clean", [electricity()], baseline="single-clean")
    write("single-net", [electricity(net=20)], "L1.ARITH.NET_TOTAL", {
        "source_locator": {"sheet": "Elektro", "row": 6},
    }, "bom", baseline="single-clean")


def generate_layer3(out):
    out.mkdir(parents=True, exist_ok=True)
    gutter = Item("01.0010", "Dachrinne Kupfer halbrund", 10, "m", 10, 100,
                  "Hängedachrinne halbrund aus Kupfer, Zuschnitt 333 mm, einschließlich Rinnenhalter liefern und montieren.")
    power = Item("01.0010", "Leerrohre für Signaltechnik liefern", 5, "m", 10, 50)
    for name, changed in (("gutter-clean", False), ("gutter-conflict", True)):
        item = replace(gutter, detail=gutter.detail.replace("Kupfer", "Titanzink")) if changed else gutter
        path = out / f"{name}.xls"
        workbook(path, [("Elektro", [power], 0, 0), ("Dach", [item], 0, 0)])
        write_fixture_labels(path, "gutter-clean.xls", {
            "control": not changed, "expect": ["L3.TEXT.SHORT_LONG_CONTRADICTION"] if changed else [],
            "match": "line", "layers": [3],
            "target": {"line_codes": [item.code], "severity": "warning", "source_locator": {"sheet": "Dach", "row": 3}},
        })


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out", type=Path)
    parser.add_argument("--layer3", action="store_true", help="generate the material contradiction and its control")
    args = parser.parse_args()
    (generate_layer3 if args.layer3 else generate)(args.out)
