"""Excel / CSV import. Fixtures are generated with openpyxl at test time: no binaries are committed."""

from io import BytesIO
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
for path in (ROOT, ROOT / "importer"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

openpyxl = pytest.importorskip("openpyxl")
from openpyxl.styles import Font  # noqa: E402

from tender_import import spreadsheet  # noqa: E402
from tender_import.common import detect_format  # noqa: E402
from tender_import.spreadsheet import excel, numeric_code, validate_mapping  # noqa: E402

HEADER = ["OZ", "Kurztext", "Langtext", "Menge", "ME", "EP", "GP"]


def workbook(*sheets):
    """sheets: (name, rows) -> xlsx bytes. A row is a list of cell values; a (value, {"bold": True}) tuple styles a cell."""
    book = openpyxl.Workbook()
    book.remove(book.active)
    for name, rows in sheets:
        sheet = book.create_sheet(name)
        for row_number, row in enumerate(rows, 1):
            for column, cell in enumerate(row, 1):
                value, style = cell if isinstance(cell, tuple) else (cell, {})
                target = sheet.cell(row_number, column)
                target.value = value
                if style.get("bold"):
                    target.font = Font(bold=True)
                if "fmt" in style:
                    target.number_format = style["fmt"]
    buffer = BytesIO()
    book.save(buffer)
    return buffer.getvalue()


def single(rows, name="LV"):
    return workbook((name, rows))


def items(result):
    return [r.payload for r in result.records if r.kind == "item_candidate"]


def sections(result):
    return [r.payload for r in result.records if r.kind == "section_candidate"]


def codes(result, kind):
    return [i["code"] for i in (items(result) if kind == "item" else sections(result))]


def issue_codes(result):
    return [i["code"] for i in result.issues]


# --------------------------------------------------------------------------- format detection


@pytest.mark.parametrize("name, expected", [
    ("lv.xlsx", "xlsx"), ("LV.XLSM", "xlsx"), ("lv.xls", "xls"), ("lv.csv", "csv"), ("lv.tsv", "csv"),
    ("lv.pdf", "pdf"), ("lv.x83", "gaeb_xml"), ("lv.d83", "gaeb_1990"), ("lv.bin", "unsupported"),
])
def test_detect_format(name, expected):
    assert detect_format(name, b"") == expected


# --------------------------------------------------------------------------- header detection


def test_title_block_and_header_in_row_six():
    merged = [["Leistungsverzeichnis Neubau Halle", None, None, None, None, None, None],
              ["Projekt 4711"], [], ["Stand: 21.11.2026"], [],
              HEADER,
              ["01", "Rohbau", None, None, None, None, None],
              ["01.0010", "Beton C25/30", "Ortbeton", 12.5, "m3", 100, 1250]]
    data = workbook(("LV", merged))
    # merge the title cell like a real export does
    book = openpyxl.load_workbook(BytesIO(data))
    book["LV"].merge_cells("A1:G1")
    out = BytesIO()
    book.save(out)
    result = excel(out.getvalue(), "xlsx")
    assert codes(result, "item") == ["01.0010"]
    item = items(result)[0]
    assert (item["quantity"], item["unit"], item["unit_price"], item["line_amount"]) == ("12.5", "m3", "100", "1250")
    assert item["short_description"] == "Beton C25/30" and item["long_description"] == "Ortbeton"
    header = next(r.payload for r in result.records if r.kind == "boq_header")
    assert header["boq_title"] == "Leistungsverzeichnis Neubau Halle"
    assert header["header_row"] == 6 and header["column_map"]["quantity"] == "D"
    assert not result.issues


def test_two_row_header():
    rows = [["Pos.", "Kurztext", "Menge", "Einheit", "Preis [EUR]", None],
            ["Nr.", None, "LV", None, "EP", "GP"],
            ["01.0010", "Estrich", 100, "m2", 10, 1000]]
    result = excel(single(rows), "xlsx")
    assert codes(result, "item") == ["01.0010"]
    item = items(result)[0]
    assert (item["unit_price"], item["line_amount"], item["unit"]) == ("10", "1000", "m2")


def test_header_synonyms_with_umlauts_and_suffixes():
    rows = [["Ordnungszahl", "Bezeichnung", "Menge (LV)", "Einheit", "Einheitspreis in EUR", "Gesamtpreis EUR"],
            ["1.1.10", "Wand", 3, "St", 5, 15]]
    result = excel(single(rows), "xlsx")
    assert codes(result, "item") == ["1.1.10"]
    assert result.metadata["currency"] == "EUR"


def test_weak_header_warns_for_review():
    rows = [["Pos", "Menge"], ["01.0010", 3]]
    result = excel(single(rows), "xlsx")
    assert "excel_mapping_review" in issue_codes(result)
    assert codes(result, "item") == ["01.0010"]


def test_no_header_gives_warning_and_no_records():
    result = excel(single([["Name", "Alter"], ["Anna", 33]]), "xlsx")
    assert "excel_no_header" in issue_codes(result)
    assert not [r for r in result.records if r.kind in {"item_candidate", "boq_header"}]
    assert result.needs_review


# --------------------------------------------------------------------------- rows


def test_numeric_oz_is_rebuilt_from_number_format():
    rows = [HEADER,
            [(1.001, {"fmt": "00.0000"}), "A", None, 1, "St", None, None],
            [(1.0020, {"fmt": "00.0000"}), "B", None, 1, "St", None, None],
            [(10010, {"fmt": r"00\.0000"}), "C", None, 1, "St", None, None],
            [(1000030, {"fmt": r"00\.00\.0000"}), "D", None, 1, "St", None, None],
            [(7, {"fmt": "0000"}), "E", None, 1, "St", None, None]]
    result = excel(single(rows), "xlsx")
    assert codes(result, "item") == ["01.0010", "01.0020", "01.0010", "01.00.0030", "0007"]
    assert not result.issues


def test_numeric_code_without_format_warns_that_zeros_may_be_lost():
    result = excel(single([HEADER, [1.1, "A", None, 1, "St", None, None]]), "xlsx")
    assert codes(result, "item") == ["1.1"]
    assert "excel_code_numeric" in issue_codes(result)


def test_numeric_code_helper():
    assert numeric_code(1.001, "00.0000") == ("01.0010", True)
    assert numeric_code(5, "General") == ("5", True)
    assert numeric_code(1.1, "General") == ("1.1", False)


def test_german_number_text_and_unit_split_from_quantity():
    rows = [HEADER,
            ["01.0010", "A", None, "1.234,50", "m", "12,5", "15.431,25"],
            ["01.0020", "B", None, "12,5 m2", None, None, None],
            ["01.0030", "C", None, "pauschal", "psch", None, None],
            ["01.0040", "D", None, "0,000", "m", None, None]]
    result = excel(single(rows), "xlsx")
    a, b, c, d = items(result)
    assert (a["quantity"], a["unit_price"], a["line_amount"]) == ("1234.50", "12.5", "15431.25")
    assert (b["quantity"], b["unit"], b["quantity_raw"]) == ("12.5", "m2", "12,5 m2")
    assert (c["quantity"], c["quantity_raw"]) == (None, "pauschal")
    assert "excel_quantity_unreadable" in issue_codes(result)
    assert d["quantity"] == "0.000"


def test_continuation_rows_extend_long_text_and_last_row_amounts_attach():
    rows = [["OZ", "Kurztext", "Menge", "ME", "EP", "GP"],
            ["01.0010", "Wandfliesen", None, None, None, None],
            [None, "Fliesen 30x60, Feinsteinzeug,", None, None, None, None],
            [None, "rektifiziert, R9", None, None, None, None],
            [None, None, 25, "m2", 40, 1000],
            ["01.0020", "Silikonfuge", 10, "m", 3, 30]]
    result = excel(single(rows), "xlsx")
    first, second = items(result)
    assert first["short_description"] == "Wandfliesen"
    assert first["long_description"] == "Fliesen 30x60, Feinsteinzeug,\nrektifiziert, R9"
    assert (first["quantity"], first["unit"], first["line_amount"]) == ("25", "m2", "1000")
    assert second["quantity"] == "10" and second["long_description"] is None


def test_text_row_without_item_is_a_note():
    rows = [HEADER, [None, "Vorbemerkung: alles inklusive"], ["01.0010", "A", None, 1, "St", None, None]]
    result = excel(single(rows), "xlsx")
    assert [r.payload["text"] for r in result.records if r.kind == "note"] == ["Vorbemerkung: alles inklusive"]
    assert items(result)[0]["long_description"] is None


def test_uncached_formula_is_none_with_warning():
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.append(HEADER)
    sheet.append(["01.0010", "A", None, 4, "St", 10, "=D2*F2"])
    out = BytesIO()
    book.save(out)  # openpyxl writes no cached result
    result = excel(out.getvalue(), "xlsx")
    item = items(result)[0]
    assert item["line_amount"] is None and item["unit_price"] == "10"
    warnings = [i for i in result.issues if i["code"] == "excel_formula_uncached"]
    assert warnings and warnings[0]["locator"]["cell"] == "G2"


def test_repeated_header_rows_are_skipped():
    rows = [HEADER, ["01.0010", "A", None, 1, "St", None, None],
            HEADER, ["01.0020", "B", None, 2, "St", None, None]]
    assert codes(excel(single(rows), "xlsx"), "item") == ["01.0010", "01.0020"]
    two = [["Pos.", "Kurztext", "Menge", "Einheit", "Preis", None], ["Nr.", None, "LV", None, "EP", "GP"],
           ["01.0010", "A", 1, "St", 1, 1],
           ["Pos.", "Kurztext", "Menge", "Einheit", "Preis", None], ["Nr.", None, "LV", None, "EP", "GP"],
           ["01.0020", "B", 2, "St", 1, 2]]
    assert codes(excel(single(two), "xlsx"), "item") == ["01.0010", "01.0020"]


def test_sections_by_depth_bold_and_label():
    rows = [HEADER,
            ["01", "Rohbau", None, None, None, None, None],
            ["01.01", "Erdarbeiten", None, None, None, None, None],
            ["01.01.0010", "Aushub", None, 10, "m3", None, None],
            ["01.01.0020", "Verfüllung", None, 5, "m3", None, None],
            ["Titel 02 Ausbau"],
            ["02.0010", "Putz", None, 3, "m2", None, None],
            [("03", {"bold": True}), ("Maler", {"bold": True}), None, None, None, None, None],
            ["03.0010", "Anstrich", None, 3, "m2", None, None]]
    result = excel(single(rows), "xlsx")
    assert codes(result, "section") == ["01", "01.01", "02", "03"]
    assert [s["label"] for s in sections(result)] == ["Rohbau", "Erdarbeiten", "Ausbau", "Maler"]
    assert sections(result)[1]["section_path"] == ["01"]
    assert [i["section_path"] for i in items(result)] == [["01", "01.01"], ["01", "01.01"], ["02"], ["03"]]


def test_totals_become_subtotals_and_net_total():
    rows = [HEADER,
            ["01", "Rohbau"],
            ["01.0010", "A", None, 2, "St", 10, 20],
            ["01.0020", "B", None, 1, "St", 5, 5],
            [None, "Summe 01 Rohbau", None, None, None, None, 25],
            [None, "Übertrag", None, None, None, None, 25],
            [None, "Nettosumme", None, None, None, None, 25],
            [None, "zzgl. 19% MwSt", None, None, None, None, 4.75]]
    result = excel(single(rows), "xlsx")
    assert len(items(result)) == 2  # totals are not items
    subtotal = next(r.payload for r in result.records if r.kind == "subtotal")
    assert (subtotal["code_parts"], subtotal["reported_amount"]) == (["01"], "25")
    assert next(r.payload for r in result.records if r.kind == "summary")["net_total"] == "25"
    assert [r.payload["label"] for r in result.records if r.kind == "reported_amount"] == [
        "Summe 01 Rohbau", "Übertrag", "Nettosumme", "zzgl. 19% MwSt"]


def test_unit_price_only_from_text_in_price_columns():
    rows = [HEADER, ["01.0010", "A", None, 2, "St", "nur EP", None], ["01.0020", "B", None, 1, "St", "...", "....."],
            ["01.0030", "C", None, 1, "St", 5, 5]]
    a, b, c = items(excel(single(rows), "xlsx"))
    assert a["flags"].get("unit_price_only") and a["unit_price"] is None
    assert b["flags"].get("unit_price_only")
    assert "unit_price_only" not in c["flags"]


def test_position_type_column_sets_gaeb_style_flags():
    rows = [["OZ", "Kurztext", "Menge", "ME", "Pos.-Art"],
            ["01.0010", "Normal", 1, "St", None],
            ["01.0020", "Grund", 1, "St", "Grundposition"],
            ["01.0030", "Alt", 1, "St", "Wahlposition"],
            ["01.0040", "Bedarf", 1, "St", "Bedarfsposition"],
            ["01.0050", "Bedarf mit GB", 1, "St", "Bedarfsposition mit GB"],
            ["01.0060", "Eventual", 1, "St", "E"],
            ["01.0070", "Seltsam", 1, "St", "Zebra"]]
    result = excel(single(rows), "xlsx")
    flags = [i["flags"] for i in items(result)]
    assert flags[0] == {}
    assert flags[1] == {"position_type": "G"}
    assert flags[2] == {"position_type": "A"}
    assert flags[3] == {"provisional_flag": "E"}
    assert flags[4] == {"Provis": "WithTotal"}
    assert flags[5] == {"provisional_flag": "E"}
    assert "excel_position_type_unknown" in issue_codes(result)

    from analysis import adapter
    lines = adapter.from_import(result).lines
    rules = [(line.code, line.total_rule) for line in lines]
    assert rules[3] == ("01.0040", "unit_price_only") and rules[2] == ("01.0030", "conditional")
    assert rules[0] == ("01.0010", "include")


def test_marker_text_in_short_text_sets_flag_like_the_pdf_parser():
    rows = [HEADER, ["01.0010", "*** Bedarfsposition ohne GB", None, 2, "St", None, None]]
    assert items(excel(single(rows), "xlsx"))[0]["flags"]["unit_price_only"] is True


def test_separate_title_column():
    rows = [["Titel", "Pos", "Kurztext", "Menge", "ME"],
            ["01", None, "Rohbau", None, None],
            ["01", "0010", "Beton", 2, "m3"],
            ["01", "0020", "Stahl", 1, "t"]]
    result = excel(single(rows), "xlsx")
    assert codes(result, "section") == ["01"]
    assert codes(result, "item") == ["01.0010", "01.0020"]


# --------------------------------------------------------------------------- sheets and mapping


def test_two_boq_sheets_and_a_sheet_without_header():
    data = workbook(("Erdarbeiten", [HEADER, ["01.0010", "A", None, 1, "m3", None, None]]),
                    ("Deckblatt", [["Projekt"], ["Neubau"]]),
                    ("Rohbau", [HEADER, ["02.0010", "B", None, 2, "m3", None, None]]))
    result = excel(data, "xlsx")
    headers = [r.payload for r in result.records if r.kind == "boq_header"]
    assert [(h["boq_index"], h["sheet"], h["boq_title"]) for h in headers] == [(1, "Erdarbeiten", "Erdarbeiten"), (2, "Rohbau", "Rohbau")]
    assert [(i["boq_index"], i["code"]) for i in items(result)] == [(1, "01.0010"), (2, "02.0010")]
    assert any(i["code"] == "excel_sheet_skipped" and i["locator"]["sheet"] == "Deckblatt" for i in result.issues)

    from analysis import adapter
    first = adapter.from_import(result, boq_index=1)
    second = adapter.from_import(result, boq_index=2)
    assert [l.code for l in first.lines] == ["01.0010"] and [l.code for l in second.lines] == ["02.0010"]
    with pytest.raises(ValueError):
        adapter.from_import(result)


def test_mapping_override_on_a_sheet_without_header():
    rows = [["Neubau Halle"], ["01.0010", "Aushub", 12, "m3"], ["01.0020", "Verfüllung", 5, "m3"]]
    data = single(rows)
    assert "excel_no_header" in issue_codes(excel(data, "xlsx"))
    mapping = {"code": "A", "short_text": "B", "quantity": 3, "unit": "d", "header_row": 0}
    result = excel(data, "xlsx", mapping)
    assert [(i["code"], i["quantity"], i["unit"]) for i in items(result)] == [("01.0010", "12", "m3"), ("01.0020", "5", "m3")]
    assert result.metadata["column_map"]["LV"]["code"] == "A"


def test_mapping_override_beats_wrong_detection():
    rows = [["OZ", "Kurztext", "Menge", "ME"], ["01.0010", "Aushub", 12, "m3"]]
    result = excel(single(rows), "xlsx", {"code": "A", "short_text": "B", "quantity": "C", "unit": "D", "header_row": 1})
    assert items(result)[0]["quantity"] == "12"
    # swapping short text and unit columns is honoured
    result = excel(single(rows), "xlsx", {"code": "A", "short_text": "D", "quantity": "C", "unit": "B", "header_row": 1})
    assert (items(result)[0]["short_description"], items(result)[0]["unit"]) == ("m3", "Aushub")


@pytest.mark.parametrize("mapping", [
    "x", {"code": "A"}, {"code": "A", "quantity": "B", "zebra": "C"}, {"code": "A", "quantity": "A"},
    {"code": "1A", "quantity": "B"}, {"code": "A", "quantity": "B", "header_row": -1},
])
def test_invalid_mappings_are_rejected(mapping):
    with pytest.raises(ValueError):
        validate_mapping(mapping)


def test_mapping_limited_to_one_sheet_leaves_other_sheets_on_auto_detection():
    data = workbook(("Frei", [["Neubau"], ["01.0010", "Aushub", 12, "m3"]]),
                    ("Auto", [HEADER, ["02.0010", "B", None, 2, "m3", None, None]]))
    mapping = {"sheet": "Frei", "code": "A", "short_text": "B", "quantity": "C", "unit": "D", "header_row": 0}
    result = excel(data, "xlsx", mapping)
    assert [(i["sheet"], i["code"]) for i in items(result)] == [("Frei", "01.0010"), ("Auto", "02.0010")]


# --------------------------------------------------------------------------- CSV and .xls


CSV_TEXT = ("Leistungsverzeichnis;;;;\n"
            "OZ;Kurztext;Menge;ME;EP;GP\n"
            "01;Rohbau;;;;\n"
            "01.0010;Beton C25/30;12,5;m3;100,00;1.250,00\n"
            "01.0020;Schalung;40;m2;nur EP;\n")


def test_csv_semicolon_utf8_and_cp1252():
    for data in (CSV_TEXT.encode("utf-8"), ("﻿" + CSV_TEXT).encode("utf-8"),
                 CSV_TEXT.replace("Rohbau", "Rohbäu").encode("cp1252")):
        result = excel(data, "csv")
        first, second = items(result)
        assert (first["code"], first["quantity"], first["unit"], first["unit_price"], first["line_amount"]) == (
            "01.0010", "12.5", "m3", "100.00", "1250.00")
        assert second["flags"]["unit_price_only"]
        assert codes(result, "section") == ["01"]
        assert next(r.payload for r in result.records if r.kind == "boq_header")["boq_title"] == "Leistungsverzeichnis"


def test_csv_comma_and_tab_delimiters():
    comma = "OZ,Kurztext,Menge,ME\n01.0010,Aushub,12,m3\n01.0020,Beton,5,m3\n01.0030,Putz,7,m2\n"
    assert codes(excel(comma.encode(), "csv"), "item") == ["01.0010", "01.0020", "01.0030"]
    tab = comma.replace(",", "\t")
    assert codes(excel(tab.encode(), "csv"), "item") == ["01.0010", "01.0020", "01.0030"]


def test_csv_keeps_leading_zeros_in_codes():
    result = excel(CSV_TEXT.encode(), "csv")
    assert codes(result, "item")[0] == "01.0010"


def test_xls_is_read_through_xlrd(monkeypatch):
    xlrd = pytest.importorskip("xlrd")
    rows = [["OZ", "Kurztext", "Menge", "ME"], ["01.0010", "Aushub", 12.0, "m3"], ["", "", "", ""]]

    class FakeSheet:
        name, nrows, ncols = "LV", len(rows), 4

        def cell(self, r, c):
            value = rows[r][c]
            if value == "":
                return SimpleNamespace(ctype=xlrd.XL_CELL_EMPTY, value="", xf_index=0)
            ctype = xlrd.XL_CELL_NUMBER if isinstance(value, float) else xlrd.XL_CELL_TEXT
            return SimpleNamespace(ctype=ctype, value=value, xf_index=0)

    xf = SimpleNamespace(format_key=1, font_index=0)
    book = SimpleNamespace(sheets=lambda: [FakeSheet()], datemode=0, xf_list=[xf],
                           format_map={1: SimpleNamespace(format_str="General")},
                           font_list=[SimpleNamespace(bold=0)])
    monkeypatch.setattr(xlrd, "open_workbook", lambda **kwargs: book)
    result = excel(b"ignored", "xls")
    assert [(i["code"], i["quantity"], i["unit"]) for i in items(result)] == [("01.0010", "12", "m3")]
    assert result.format == "xls"


# --------------------------------------------------------------------------- safety


def test_corrupt_and_oversized_xlsx_are_refused(monkeypatch):
    with pytest.raises(ValueError):
        excel(b"not a zip", "xlsx")
    monkeypatch.setattr("tender_import.common.MAX_ARCHIVE_ENTRIES", 2)
    with pytest.raises(ValueError, match="entries"):
        excel(single([HEADER]), "xlsx")


# --------------------------------------------------------------------------- GAEB -> xlsx -> excel() round trip


GAEB = """<?xml version="1.0"?>
<GAEB xmlns="http://www.gaeb.de/GAEB_DA_XML/DA83/3.2">
  <GAEBInfo><Version>3.2</Version></GAEBInfo>
  <PrjInfo><Cur>EUR</Cur></PrjInfo>
  <Award><DP>83</DP><BoQ><BoQInfo><Name>LV</Name><LblBoQ>Testprojekt</LblBoQ></BoQInfo><BoQBody>
    <BoQCtgy RNoPart="01"><LblTx>Rohbau</LblTx><BoQBody>
      <BoQCtgy RNoPart="01"><LblTx>Erdarbeiten</LblTx><BoQBody><Itemlist>
        <Item RNoPart="0010"><Qty>12.500</Qty><QU>m3</QU><UP>8.50</UP><IT>106.25</IT>
          <Description><CompleteText><OutlineText><OutlTxt><TextOutlTxt>Aushub</TextOutlTxt></OutlTxt></OutlineText>
          <DetailTxt><Text>Boden lösen und laden</Text></DetailTxt></CompleteText></Description></Item>
        <Item RNoPart="0020"><Qty>40.000</Qty><QU>m2</QU>
          <Description><CompleteText><OutlineText><OutlTxt><TextOutlTxt>Planum</TextOutlTxt></OutlTxt></OutlineText></CompleteText></Description></Item>
      </Itemlist></BoQBody></BoQCtgy>
      <BoQCtgy RNoPart="02"><LblTx>Beton</LblTx><BoQBody><Itemlist>
        <Item RNoPart="0010"><LumpSumItem>Yes</LumpSumItem><Qty>1.000</Qty><QU>psch</QU>
          <Description><CompleteText><OutlineText><OutlTxt><TextOutlTxt>Baustelleneinrichtung</TextOutlTxt></OutlTxt></OutlineText></CompleteText></Description></Item>
      </Itemlist></BoQBody></BoQCtgy>
    </BoQBody></BoQCtgy>
  </BoQBody></BoQ></Award>
</GAEB>""".encode("utf-8")


def gaeb_to_xlsx(gaeb_result, header=HEADER):
    """Write an importer result as the kind of sheet an AVA program exports (text OZ, bold titles)."""
    rows = [["Leistungsverzeichnis"], [], header]
    for record in gaeb_result.records:
        payload = record.payload
        if record.kind == "section":
            code = ".".join(payload["code_parts"])
            rows.append([(code, {"bold": True}), (payload["label"], {"bold": True}), None, None, None, None, None])
        elif record.kind == "item":
            def number(raw):
                return float(raw) if raw is not None else None
            rows.append([payload["code"], payload["short_description"], payload["long_description"],
                         number(payload["quantity"]), payload["unit"], number(payload["unit_price"]),
                         number(payload["line_amount"])])
    return workbook(("LV", rows))


def comparable(analysis_input):
    return ([(l.code, l.quantity, l.unit, l.short_text) for l in analysis_input.lines],
            [(s.code, s.title) for s in analysis_input.sections])


def test_gaeb_to_xlsx_round_trip_gives_the_same_positions():
    from analysis import adapter
    from tender_import.structured import gaeb_xml

    original = gaeb_xml(GAEB)
    via_excel = excel(gaeb_to_xlsx(original), "xlsx")
    assert comparable(adapter.from_import(via_excel)) == comparable(adapter.from_import(original))
    lines = adapter.from_import(via_excel).lines
    assert [l.code for l in lines] == ["01.01.0010", "01.01.0020", "01.02.0010"]
    assert lines[0].source_amounts.line_amount == adapter.from_import(original).lines[0].source_amounts.line_amount


def test_round_trip_through_csv():
    from analysis import adapter
    from tender_import.structured import gaeb_xml

    original = gaeb_xml(GAEB)
    book = openpyxl.load_workbook(BytesIO(gaeb_to_xlsx(original)))
    lines = []
    for row in book["LV"].iter_rows(values_only=True):
        lines.append(";".join("" if v is None else str(v).replace(".", ",") if isinstance(v, float) else str(v) for v in row))
    # a CSV export writes German decimals; codes stay text
    via_csv = excel("\n".join(lines).encode("utf-8"), "csv")
    assert comparable(adapter.from_import(via_csv))[0] == comparable(adapter.from_import(original))[0]
