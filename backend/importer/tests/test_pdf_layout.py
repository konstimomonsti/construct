"""PDF layout cases A-D, the marker line and the xpdf check, on synthetic text, plus golden GAEB/PDF pairs."""

from pathlib import Path
from textwrap import dedent
import os
import unittest
from unittest import mock

from tender_import import pdf as pdf_module
from tender_import.common import Result
from tender_import.pdf import check_poppler_banner, extract_pdf_tables, read_quantity

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / "data" / "tenders"
HEADER = "Pos-Nr.       Menge ME               EP             GP"


def extract(*pages):
    result = Result("pdf")
    extract_pdf_tables([dedent(page) for page in pages], result)
    items = [rec.payload for rec in result.records if rec.kind == "item_candidate"]
    sections = [rec.payload for rec in result.records if rec.kind == "section_candidate"]
    return items, sections, result



def test_ocr_unit_reread_requires_matching_price_rows_and_agreement():
    layout = " 5,000   m?   10,00   50,00\n 7,000   m?   10,00   70,00\n"
    boxes = b"""
        <html><word xMin="300" yMin="100" xMax="309" yMax="107">m?</word>
        <word xMin="300" yMin="131" xMax="309" yMax="138">m?</word></html>
    """
    render = mock.Mock(side_effect=[b"first", b"second"])
    recognize = mock.Mock(side_effect=[b"m2", b"m2", b"m3", b"m?"])
    revised, details = pdf_module._reread_ocr_units(layout, lambda: boxes, render, recognize)
    assert revised == layout.replace("m?", "m²", 1)
    assert len(details) == 1
    assert (details[0]["line"], details[0]["original"], details[0]["readings"]) == (1, "m?", ["m2", "m2"])

    multi_column = boxes.replace(b'xMin="300" yMin="131"', b'xMin="500" yMin="131"')
    render.reset_mock()
    assert pdf_module._reread_ocr_units(layout, lambda: multi_column, render, recognize) == (layout, [])
    render.assert_not_called()


def warning_codes(result):
    return [issue["code"] for issue in result.issues]


def poppler_available():
    try:
        pdf_module.check_poppler()
        return True
    except (ValueError, OSError):
        return False


class SyntheticLayoutTests(unittest.TestCase):
    def test_cause_a_one_space_before_dotted_tail(self):
        items, _, result = extract(f"""\
            {HEADER}
            6.1.10        Anschluss herstellen
                          1,000 PSCH .........................   .........................
            6.1.20        Zweite Position
                          12,500 m   .........................   .........................
        """)
        self.assertEqual([(i["code"], i["quantity"], i["unit"]) for i in items],
                         [("6.1.10", "1.000", "PSCH"), ("6.1.20", "12.500", "m")])
        self.assertNotIn("pdf_quantity_review", warning_codes(result))

    def test_cause_a_regex_keeps_dotted_units_and_two_space_tails(self):
        self.assertEqual(read_quantity("5 St.  10,00  50,00")["unit"], "St.")
        self.assertEqual(read_quantity("5 m  EP.......  GP.......")["unit"], "m")
        self.assertIsNone(read_quantity("5 Stück ....."))

    def test_cause_b_quantity_without_unit_keeps_the_missing_unit(self):
        items, _, result = extract(f"""\
            {HEADER}
            1.4.7         Werkplanung, BIM, Intern
                                1,000            .........................   .........................
        """)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["quantity"], "1.000")
        self.assertIsNone(items[0]["unit"])
        self.assertNotIn("pdf_quantity_review", warning_codes(result))

    def test_cause_c_heading_with_sub_items_becomes_a_section(self):
        items, sections, result = extract(f"""\
            {HEADER}
            1.3.          KG 444
            1.3.1.        Kabel und Leitung
            1.3.1.1       Energiekabel NYCWY
                          Energiekabel NYCWY
                                         80,000 m      .........................   .........................
            1.3.1.2       PVC-Mantelleitung
                                         250,000 m     .........................   .........................
        """)
        self.assertEqual([i["code"] for i in items], ["1.3.1.1", "1.3.1.2"])
        self.assertIn(("1.3.1.", "Kabel und Leitung"), [(s["code"], s["label"]) for s in sections])
        self.assertEqual(items[0]["section_path"][-1], "1.3.1.")
        self.assertNotIn("pdf_quantity_review", warning_codes(result))

    def test_cause_c_item_without_sub_items_is_still_reviewed(self):
        items, _, result = extract(f"""\
            {HEADER}
            1.3.1.1       Energiekabel
            1.3.1.2       Zweites Kabel
                                         250,000 m     .........................   .........................
        """)
        self.assertEqual([i["code"] for i in items], ["1.3.1.1", "1.3.1.2"])
        self.assertEqual([w["locator"]["code"] for w in result.issues if w["code"] == "pdf_quantity_review"],
                         ["1.3.1.1"])

    def test_cause_d_wrapped_header_on_a_continuation_page(self):
        items, _, _ = extract(f"""\
            {HEADER}
            2.1.4         Bestands-Dokumentation erstellen
                          Bestandsunterlagen aller Arbeiten
        """, """\
            LV: BEISPIEL                                        Seite:    16
            Pos-Nr. (Pos-                                    Einheit
                               Mengemit Zuordnung der Linien       Einheitspreis in   Gesamtpreis in
            Nr.)                                                          EUR               EUR
                            Die Planung wird dem AN zur Verfuegung gestellt.

                            1,000      psch                          400,000              400,00

            2.1.5         Naechste Position
                            2,000      St                              5,000               10,00
        """)
        self.assertEqual([(i["code"], i["quantity"], i["unit"]) for i in items],
                         [("2.1.4", "1.000", "psch"), ("2.1.5", "2.000", "St")])
        self.assertIn("Die Planung wird dem AN", items[0]["long_description"])
        self.assertNotIn("Mengemit", items[0]["long_description"])

    def test_cause_d_header_text_between_its_lines_is_not_description(self):
        items, _, _ = extract(f"""\
            {HEADER}
            1.1.1         Fotos liefern
        """, """\
            Pos-Nr. (Pos-                                    Einheit
                               Menge Unterlagen im Format PDF,
            Digitale                                                      Einheitspreis in     Gesamtpreis in
            Nr.)            Fotos im Format JPG                                    EUR                 EUR


                            10,000      St
        """)
        self.assertEqual([(i["code"], i["quantity"], i["unit"]) for i in items], [("1.1.1", "10.000", "St")])
        self.assertNotIn("Digitale", items[0]["long_description"])

    def test_header_like_text_without_menge_is_not_a_header(self):
        items, _, _ = extract("""\
            Nr. 5 der Vorbemerkung gilt
            1.1.1         Kein Kopf auf dieser Seite
                          1,000 m   10,00   10,00
        """)
        self.assertEqual(items, [])

    def test_marker_line_is_not_the_short_text(self):
        items, _, _ = extract(f"""\
            {HEADER}
            1.3.2.5       *** Bedarfsposition ohne GB
                          Kabelkanal Stahlblech 70x110mm
                          Kabelkanal Stahlblech 70x110mm
                          weiss oder hellgrau
                                         200,000 m      .........................   Nur Einh.-Pr.
            1.3.2.6       *** Grundposition 1.0
                          Kabelrinne 400 x 60
                                         120,000 m      .........................   .........................
        """)
        self.assertEqual([i["short_description"] for i in items],
                         ["Kabelkanal Stahlblech 70x110mm", "Kabelrinne 400 x 60"])
        self.assertTrue(items[0]["flags"]["unit_price_only"])
        self.assertTrue(items[1]["flags"]["base_item"])
        self.assertIn("*** Bedarfsposition ohne GB", items[0]["long_description"])

    def test_loose_quantity_scan_is_a_marked_fallback(self):
        items, _, result = extract(f"""\
            {HEADER}
            1.1.1         Rohr verlegen
              3,000 Stk .....
            1.1.2         Ohne Menge
        """)
        self.assertEqual((items[0]["quantity"], items[0]["unit"], items[0]["quantity_source"]),
                         ("3.000", "Stk", "fallback"))
        self.assertIsNone(items[1].get("quantity"))
        self.assertEqual(warning_codes(result), ["pdf_quantity_fallback", "pdf_quantity_review"])


class PopplerCheckTests(unittest.TestCase):
    XPDF = "pdftotext version 4.00\nCopyright 1996-2017 Glyph & Cog, LLC\n"
    POPPLER = "pdftotext version 24.04.0\nCopyright 2005-2024 The Poppler Developers - http://poppler.freedesktop.org\n"

    def setUp(self):
        pdf_module._POPPLER_CHECKED.clear()
        self.addCleanup(pdf_module._POPPLER_CHECKED.clear)
        patcher = mock.patch.dict(os.environ)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("POPPLER_BIN", None)

    def fake_run(self, banner, calls):
        def fake(command, **kwargs):
            calls.append(command)
            return mock.Mock(returncode=0, stdout=b"text", stderr=banner.encode())
        return fake

    def test_xpdf_banner_is_refused_with_a_clear_message(self):
        with self.assertRaisesRegex(ValueError, "xpdf, not Poppler.*POPPLER_BIN"):
            check_poppler_banner(self.XPDF)

    def test_poppler_banner_is_accepted(self):
        check_poppler_banner(self.POPPLER)

    def test_unrecognised_banner_only_warns(self):
        with self.assertWarns(UserWarning):
            check_poppler_banner("pdftotext 1.0")

    def test_poppler_refuses_xpdf_before_extracting(self):
        calls = []
        with mock.patch.object(pdf_module, "run", self.fake_run(self.XPDF, calls)):
            with self.assertRaisesRegex(ValueError, "xpdf"):
                pdf_module.poppler("pdftotext", "-layout", "x.pdf", "-")
        self.assertEqual([call[1:] for call in calls], [["-v"]])

    def test_good_binary_is_checked_once(self):
        calls = []
        with mock.patch.object(pdf_module, "run", self.fake_run(self.POPPLER, calls)):
            pdf_module.poppler("pdftotext", "a.pdf", "-")
            pdf_module.poppler("pdftotext", "b.pdf", "-")
        self.assertEqual([call[1] for call in calls], ["-v", "a.pdf", "b.pdf"])

    def test_poppler_bin_must_hold_the_tool(self):
        os.environ["POPPLER_BIN"] = str(ROOT / "no-such-folder")
        with self.assertRaisesRegex(ValueError, "POPPLER_BIN"):
            pdf_module.poppler("pdftotext", "x.pdf", "-")


@unittest.skipUnless(poppler_available(), "Poppler's pdftotext is not installed")
@unittest.skipUnless(DATA.is_dir(), "data/tenders is not present")
class GoldenPairTests(unittest.TestCase):
    """Each PDF must reproduce its GAEB twin: same positions, same quantity and unit."""

    PAIRS = [
        ("Angebot AN24-0305.pdf", "Angebot AN24-0305.D84"),
        ("Leistungsverzeichnis.pdf", "Angebot AN24-0305.D84"),
        ("HEM2301-2_Gesamt-LV.pdf", "8209.003_Leistungsverzeichnis_leer.X83"),
        ("LV-Ausdruck-[PROJEKT_004].pdf", "GAEB-[PROJEKT_004].X83"),
        ("Abgabe LV.pdf", "[NUMMER_001]_leer.X83"),
        ("Leistungsverzeichnis_leer.pdf", "[NUMMER_001]_leer.X83"),
    ]

    @staticmethod
    def key(code):
        return tuple(int(part) for part in (code or "").replace("-", ".").rstrip(".").split(".") if part.isdigit())

    def lines(self, name):
        from analysis import adapter
        from analysis.contracts import SourceDocument
        path = DATA / name
        if path.suffix.lower() == ".pdf":
            result = pdf_module.pdf(path.read_bytes())
            return adapter.from_import(result, document=SourceDocument(id=name, filename=name, format="pdf")).lines
        return adapter.from_file(path).lines

    def test_pdf_matches_its_gaeb_twin(self):
        for pdf_name, gaeb_name in self.PAIRS:
            with self.subTest(pdf=pdf_name):
                gaeb = {self.key(line.code): line for line in self.lines(gaeb_name)}
                pdf_lines = {self.key(line.code): line for line in self.lines(pdf_name)}
                self.assertEqual(sorted(set(gaeb) - set(pdf_lines)), [], "positions missing from the PDF")
                wrong = [line.code for key, line in gaeb.items()
                         if (pdf_lines[key].quantity, pdf_lines[key].unit) != (line.quantity, line.unit)]
                self.assertEqual(wrong, [], "quantity or unit differs from the GAEB file")

    def test_trade_pdfs_read_completely(self):
        # LV_00 1.4.7 really has a quantity and no unit; everything else reads completely.
        expected_missing_units = {"LV_00_Roh_und_Erdauarbeiten.pdf": ["1.4.7."]}
        for name in ("LV_00_Roh_und_Erdauarbeiten.pdf", "LV_12_Dachabdichtung.pdf", "LV_13_ELT.pdf",
                     "LV_18_Estrich.pdf"):
            with self.subTest(pdf=name):
                lines = self.lines(name)
                self.assertTrue(lines)
                self.assertEqual([line.code for line in lines if line.quantity is None], [])
                self.assertEqual([line.code for line in lines if line.unit is None],
                                 expected_missing_units.get(name, []))
                self.assertFalse([line.code for line in lines if (line.short_text or "").startswith("***")])


if __name__ == "__main__":
    unittest.main()
