from collections import Counter
from io import BytesIO
from textwrap import dedent
import unittest
from zipfile import ZipFile

from tender_import.legacy import gaeb_1990
from tender_import.pdf import extract_pdf_tables, layout_rows
from tender_import.structured import docx, gaeb_xml
from tender_import.common import Result


class FormatTests(unittest.TestCase):
    def test_xml_preserves_unknown_elements_and_decodes_quantity(self):
        data = b"""<?xml version="1.0"?>
        <!-- prolog -->
        <GAEB xmlns="gaeb" xmlns:v="vendor">
          <GAEBInfo><Version>3.2</Version></GAEBInfo>
          <Award><DP>83</DP><BoQ><BoQBody><BoQCtgy RNoPart="01">
            <LblTx>Works</LblTx><Itemlist><Item ID="x" RNoPart="0010">
              <Qty>0.000</Qty><QU>m</QU><v:unknown code="07">Unmapped</v:unknown>
            </Item></Itemlist>
          </BoQCtgy></BoQBody></BoQ></Award>
        </GAEB>"""
        result = gaeb_xml(data)
        evidence, *_, item = result.records
        self.assertEqual(evidence.payload["before_root"][0]["kind"], "comment")
        self.assertIn("{vendor}unknown", str(evidence.payload["root"]))
        self.assertEqual(item.payload["code"], "01.0010")
        self.assertEqual(item.payload["quantity"], "0.000")

    def test_xml_keeps_item_index_markup_items_and_stated_totals(self):
        data = b"""<?xml version="1.0"?>
        <GAEB xmlns="gaeb">
          <Award><DP>84</DP><BoQ>
            <BoQInfo><Totals><Total>1150.00</Total><VAT>19.00</VAT></Totals></BoQInfo>
            <BoQBody><BoQCtgy RNoPart="01"><BoQBody><Itemlist>
              <Item RNoPart="0010"><UP>10.000</UP><IT>500.00</IT></Item>
              <Item RNoPart="0010" RNoIndex="A"><UP>5.000</UP><IT>500.00</IT></Item>
              <MarkupItem RNoPart="0020"><ITMarkup>1000.00</ITMarkup><Markup>10.00</Markup><IT>100.00</IT></MarkupItem>
            </Itemlist></BoQBody>
            <Totals><Total>1100.00</Total><DiscountPcnt>10.00</DiscountPcnt><TotAfterDisc>990.00</TotAfterDisc>
            </Totals></BoQCtgy></BoQBody>
          </BoQ></Award>
        </GAEB>"""
        result = gaeb_xml(data)
        items = [rec.payload for rec in result.records if rec.kind == "item"]
        self.assertEqual([item["code"] for item in items], ["01.0010", "01.0010.A", "01.0020"])
        self.assertEqual(items[1]["code_parts"], ["01", "0010", "A"])
        markup = items[2]
        self.assertEqual(markup["line_amount"], "100.00")
        self.assertIsNone(markup["unit_price"])
        self.assertEqual({key: markup["flags"][key] for key in ("MarkupItem", "Markup", "ITMarkup")},
                         {"MarkupItem": "Yes", "Markup": "10.00", "ITMarkup": "1000.00"})
        summary = next(rec.payload for rec in result.records if rec.kind == "summary")
        self.assertEqual(summary["net_total"], "1150.00")
        subtotal = next(rec.payload for rec in result.records if rec.kind == "subtotal")
        self.assertEqual((subtotal["code_parts"], subtotal["reported_amount"], subtotal["discounted_amount"]),
                         (["01"], "1100.00", "990.00"))

    def test_legacy_price_return_has_no_invented_quantity(self):
        header = b"00        84L23A0051                                          1122PPPPI90 000001"
        price = b"2301010001  0001600000  000001600000                                      000002"
        result = gaeb_1990(header + b"\r\n" + price + b"\r\n")
        self.assertEqual(result.phase, "84")
        self.assertEqual(Counter(item.kind for item in result.records), {"legacy_record": 2, "price": 1})
        row = result.records[-1].payload
        self.assertEqual(row["unit_price"], "16000.000")
        self.assertEqual(row["line_amount"], "16000.00")
        self.assertIsNone(row["quantity"])

    def test_pdf_quote_candidates_keep_locale_and_form_boundaries(self):
        result = Result("pdf")
        extract_pdf_tables([
            dedent("""\
                223
                Nr.    Menge und Einheit
                1      1 St    2,10    2,10
            """),
            dedent("""\
                Pos-Nr.       Menge ME               EP             GP
                1.1.10        6,250 Mt                750,00         4.687,50
                              Baustelle vorhalten
                Summe (netto)                        4.687,50
            """),
        ], result)
        self.assertEqual([rec.kind for rec in result.records], ["form_page", "reported_amount", "item_candidate"])
        candidate = result.records[-1].payload
        self.assertEqual(candidate["quantity"], "6.250")
        self.assertEqual(candidate["line_amount"], "4687.50")
        self.assertEqual(layout_rows(["  first cell   second cell"])[0]["cells"],
                         [{"offset": 2, "text": "first cell"}, {"offset": 15, "text": "second cell"}])

    def test_pdf_uses_table_quantity_over_components_in_description(self):
        result = Result("pdf")
        extract_pdf_tables([dedent("""\
            Nr.       Leistungsbeschreibung       Menge / Einheit
            01 Titel Construction
            01.01 Bereich Pipework
            01.01.1   Temporary water line
                      50 m
                      28 weeks
                                           1.400,000 mWo
            01.01.2   Service work
                                           5h    EP.......    GP.......
        """)], result)
        candidates = [record.payload for record in result.records if record.kind == "item_candidate"]
        self.assertEqual([row["quantity"] for row in candidates], ["1400.000", "5"])
        self.assertEqual(candidates[0]["other_amount_candidates"][0]["quantity"], "50")
        self.assertEqual(candidates[1]["section_path"], ["01", "01.01"])

    def test_pdf_keeps_detached_specification_after_the_priced_position(self):
        result = Result("pdf")
        extract_pdf_tables([dedent("""\
            OZ        Leistungsbeschreibung        Menge / Einheit
            01.01.1    Absperrschieber DN 200
                       Vorbemerkung zur Montage
                       Bestehenden Schieber versetzen.
                                           1 St    EP.......    GP.......

                       Spezifikation Absperrklappe PN 16
                       Neue Armatur mit Handhebel montieren.
            01.01.2    Absperrklappe PN 16
                       Gemäß Spezifikation liefern.
                                           1 St    EP.......    GP.......
        """)], result)
        self.assertEqual([record.kind for record in result.records], ["item_candidate", "note", "item_candidate"])
        first, note, second = (record.payload for record in result.records)
        self.assertIn("Vorbemerkung zur Montage", first["long_description"])
        self.assertNotIn("Spezifikation Absperrklappe", first["long_description"])
        self.assertIn("Neue Armatur mit Handhebel montieren.", note["text"])
        self.assertIn("Gemäß Spezifikation liefern.", second["long_description"])

    def test_docx_preserves_duplicate_references_and_part_metadata(self):
        xml = '''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body><w:p><w:r><w:t>Utilities</w:t></w:r></w:p>
        <w:p><w:r><w:t>1.1.1 – Pipe [m]</w:t></w:r></w:p>
        <w:p><w:r><w:t>oder</w:t></w:r></w:p>
        <w:p><w:r><w:t>1.1.1 – Another pipe [m]</w:t></w:r></w:p></w:body></w:document>'''
        payload = BytesIO()
        with ZipFile(payload, "w") as package:
            package.writestr("word/document.xml", xml)
            package.writestr("word/media/example.bin", b"\x00\xf0")
        result = docx(payload.getvalue())
        items = [rec for rec in result.records if rec.kind == "item_candidate"]
        self.assertEqual([rec.payload["code"] for rec in items], ["1.1.1", "1.1.1"])
        self.assertEqual(items[1].payload["relationship_hint"], "oder")
        self.assertEqual(items[0].locator["outline_heading_paragraph"], 1)
        self.assertEqual(items[1].locator["outline_heading_paragraph"], 1)
        self.assertEqual(items[1].locator["outline_connector"], {"paragraph": 3, "text": "oder"})
        self.assertIsNone(items[0].payload["quantity"])
        self.assertEqual(result.records[-1].locator["part"], "word/media/example.bin")
        self.assertIsNotNone(result.records[-1].payload["sha256"])


if __name__ == "__main__":
    unittest.main()
