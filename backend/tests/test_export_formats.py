from decimal import Decimal
from io import BytesIO
from zipfile import ZipFile

import pytest
from pypdf import PdfReader

from exports import FORMATS, export
from tender_import.common import detect_format
from tender_import.ingest import parse_document


@pytest.fixture
def bom():
    return {
        "version": {"id": "01234567-abcd", "title": "Leitungsbau & Ausbau", "project_name": "Testwerk",
                    "currency": "EUR", "scope_notes": "Zwei Bereiche"},
        "sections": [{"display_code": "01", "title": "Versorgung"}, {"display_code": "02", "title": "Einbau"}],
        "lines": [
            {"id": "a", "line_code": "01.0010", "short_description": "Müller & <Rohr>",
             "long_description": "Erste Zeile\nZweite Zeile", "quantity": Decimal("2.125"),
             "unit_code": "m", "draft_unit_price": Decimal("12.345"), "pricing_basis": "unit_rate",
             "total_rule": "include", "alternative_for_line_id": None},
            {"id": "b", "line_code": "02.0020", "short_description": "Ventil",
             "long_description": None, "quantity": Decimal("0"), "unit_code": "ea",
             "draft_unit_price": Decimal("34.560"), "pricing_basis": "unit_rate",
             "total_rule": "include", "alternative_for_line_id": None},
        ],
    }


def record_rows(data, name):
    return parse_document(detect_format(name, data), data, None)


def assert_documents(name, data):
    result = record_rows(data, name)
    rows = [record.payload for record in result.records if record.kind == "item_candidate"]
    assert [row["code"] for row in rows] == ["01.0010", "02.0020"]
    assert rows[0]["short_description"] == "Müller & <Rohr>"
    assert rows[0]["long_description"] == "Erste Zeile\nZweite Zeile"
    assert [Decimal(row["quantity"]) for row in rows] == [Decimal("2.125"), Decimal("0")]
    assert [Decimal(row["unit_price"]) for row in rows] == [Decimal("12.345"), Decimal("34.560")]
    assert [Decimal(row["line_amount"]) for row in rows] == [Decimal("26.23"), Decimal("0")]
    if name.endswith(".pdf"):
        pdf = PdfReader(BytesIO(data))
        assert len(pdf.pages) == 1
        assert "Müller & <Rohr>" in pdf.pages[0].extract_text()
    return result


@pytest.mark.parametrize("kind", FORMATS)
def test_export_reimports_as_the_requested_format(bom, kind):
    filename, mime, data = export(bom, kind)
    ext, expected_mime = FORMATS[kind]
    assert filename == f"BOM-01234567.{ext}" and mime == expected_mime

    if kind == "zip":
        with ZipFile(BytesIO(data)) as archive:
            assert sorted(archive.namelist()) == ["BOM-01234567.docx", "BOM-01234567.pdf"]
            assert archive.testzip() is None
            for member in archive.namelist():
                assert_documents(member, archive.read(member))
        return
    if kind in {"pdf", "docx"}:
        assert_documents(filename, data)
        return

    result = record_rows(data, filename)
    assert result.phase == kind[1:3]
    rows = [record.payload for record in result.records if record.kind == "item"]
    if kind.startswith("x"):
        assert result.version == ("3.1" if kind.endswith("-31") else "3.2")
    else:
        assert all(len(record) == 80 for record in data.split(b"\r\n") if record)
    if kind == "d84":
        assert rows == []  # An offer return carries prices, without tender descriptions.
    else:
        assert [row["short_description"] for row in rows] == ["Müller & <Rohr>", "Ventil"]
        assert [Decimal(row["quantity"]) for row in rows] == [Decimal("2.125"), Decimal("0")]
        assert int(rows[0]["code"].split(".")[-1]) == 10
        assert int(rows[1]["code"].split(".")[-1]) == 20

    if kind in {"d84", "d86", "x82"}:
        prices = ([record.payload for record in result.records if record.kind == "price"]
                  if kind.startswith("d") else rows)
        assert [Decimal(row["unit_price"]) for row in prices] == [Decimal("12.345"), Decimal("34.560")]
        assert [Decimal(row["line_amount"]) for row in prices] == [Decimal("26.23"), Decimal("0")]
    elif kind.startswith("x"):
        assert all(row["unit_price"] is None for row in rows)


def test_export_rejects_empty_draft_and_overflow(bom):
    with pytest.raises(ValueError, match="no positions"):
        export({**bom, "lines": []}, "pdf")
    bom["lines"][0]["quantity"] = Decimal("123456789")
    with pytest.raises(ValueError, match="precision or width"):
        export(bom, "d83")
