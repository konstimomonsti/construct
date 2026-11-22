"""Layer 1 likely typos and accepted spelling and notation variants."""

from decimal import Decimal as D

import pytest

from analysis import layer1  # noqa: F401  registers the rules
from analysis.contracts import AnalysisInput, Line, Project, Section
from analysis.layer1 import build_lexicon, spelling
from analysis.runner import analyze

SECTION = Section(id="s1", code="01", code_parts=["01"], title="Allgemeines", sort_order=0)


class FakeHunspell:
    """Stands in for the German dictionary: knows exactly the given words."""

    def __init__(self, *words):
        self.words = set(words)

    def lookup(self, word):
        return word in self.words


LEXICON = {w: 5 for w in ("auftragnehmer", "material", "liefern", "einbauen", "bauseitigen", "boden", "kassette",
                          "erforderlichen", "anschluss", "position", "leistung", "statischen", "tischen", "graben")}
DICTIONARY = FakeHunspell("Auftragnehmer", "Material", "liefern", "Leistung", "Leitung", "Gräben", "statischen", "Bodenbelag",
                          "Desinfizierung", "gesonderten", "Anschluss", "Baustromkabel", "Sektionaltor", "Position")


@pytest.fixture(autouse=True)
def checker():
    spelling.use_checker(spelling.SpellChecker(LEXICON, DICTIONARY))
    yield
    spelling.use_checker(None)


def line(number, short="Position", long=None, **fields):
    defaults = dict(id=f"l{number}", code=f"01.{number:04d}", code_parts=["01", f"{number:04d}"], section_id="s1",
                    sort_order=number, short_text=short, long_text=long, quantity=D("1"), unit="ea", unit_raw="St")
    return Line(**{**defaults, **fields})


def run(*lines):
    data = AnalysisInput(project=Project(gaeb_phase="83", currency="EUR"), sections=[SECTION], lines=list(lines))
    return analyze(data, [1]).findings


def by_rule(findings, rule_id):
    return [f for f in findings if f.rule_id == rule_id]


# ---------------------------------------------------------------- typos


def test_typo_found_with_fix_on_every_line():
    findings = run(line(1, "Leistung", "Der Auftragnehemer hat das Material zu liefern und einzubauen."),
                   line(2, "Leistung", "Vom Auftragnehemer zu liefern."),
                   line(3, "Leistung", "Der Auftragnehmer liefert das Material."))
    [typo] = by_rule(findings, "L1.TEXT.TYPO")
    assert typo.severity == "info"
    assert typo.evidence["word"] == "Auftragnehemer" and typo.evidence["suggestion"] == "Auftragnehmer"
    assert typo.evidence["occurrences"] == 2 and typo.target.line_id == "l1" and typo.related_line_ids == ["l2"]
    new_texts = {op.line_id: op.new_value for op in typo.suggested_fix.operations}
    assert new_texts == {"l1": "Der Auftragnehmer hat das Material zu liefern und einzubauen.",
                         "l2": "Vom Auftragnehmer zu liefern."}
    assert all(op.field == "long_text" for op in typo.suggested_fix.operations)


def test_lowercase_typo_keeps_lowercase():
    [typo] = by_rule(run(line(1, "Leistung", "alle erfoderlichen Arbeiten und das Material")), "L1.TEXT.TYPO")
    assert typo.evidence["suggestion"] == "erforderlichen"
    assert typo.suggested_fix.operations[0].new_value == "alle erforderlichen Arbeiten und das Material"


def test_typo_inside_hyphenated_word():
    [typo] = by_rule(run(line(1, "Leistung", "Die Materail-Prüfung und die Abnahme")), "L1.TEXT.TYPO")
    assert typo.suggested_fix.operations[0].new_value == "Die Material-Prüfung und die Abnahme"


@pytest.mark.parametrize("text", [
    "Die bauseitigem Leistungen und der Rest",            # inflection of a known word
    "Der Bodenb elag aus Naturstein und die Fuge",        # word split by a space
    "Die SC-K assette und das Kabel",                     # word split by a space
    "Die st atischen Nachweise und die Pläne",            # first half glued to a known word
    "ist eine Desin-\nfizierung der Leitung nötig",       # broken at the line end
    "werden in einer geson- derten Position vergütet",    # broken at the line end
    "Mulden und Graeben freilegen",                       # umlauts typed as ae
    "Fabrikat: Materiol oder gleichwertig und der Rest",  # product name
    "Der MATERAIL und der Rest",                          # ALLCAPS
    "Die Leistunk. und der Rest",                         # only the last letter differs: an abbreviation
])
def test_no_typo(text):
    assert by_rule(run(line(1, "Leistung", text)), "L1.TEXT.TYPO") == []


def test_english_text_is_not_checked():
    text = "The contractor shall supply the materail and install it according to the drawings."
    assert by_rule(run(line(1, "Supply", text)), "L1.TEXT.TYPO") == []


def test_no_dictionary_no_typo_findings():
    spelling.use_checker(spelling.SpellChecker(LEXICON, use_hunspell=False))
    assert by_rule(run(line(1, "Leistung", "Der Auftragnehemer und das Material")), "L1.TEXT.TYPO") == []


def test_dictionary_location_setting(monkeypatch, tmp_path):
    monkeypatch.setenv("ANALYSIS_SPELL_DIC", "off")
    assert spelling.dictionary_path() is None
    (tmp_path / "de.dic").write_text("1\nWort\n", encoding="utf-8")
    monkeypatch.setenv("ANALYSIS_SPELL_DIC", str(tmp_path / "de.dic"))
    assert spelling.dictionary_path() is None  # no .aff next to it
    (tmp_path / "de.aff").write_text("SET UTF-8\n", encoding="utf-8")
    assert spelling.dictionary_path() == tmp_path / "de.dic"


def test_helpers():
    assert spelling.distance("materail", "material", 2) == 1
    assert spelling.distance("abc", "xyz", 1) == 2
    assert spelling.is_inflection("bauseitigem", "bauseitigen")
    assert not spelling.is_inflection("auftragnehemer", "auftragnehmer")
    assert spelling.is_cut("bodenb", "boden") and spelling.is_cut("assette", "kassette")
    assert spelling.variant_key("Baustrom-Kabel") == spelling.variant_key("baustromkabel")
    assert spelling.variant_key("Anschluß") == spelling.variant_key("Anschluss")
    assert spelling.variant_key("Sectionaltor") == spelling.variant_key("Sektionaltor")
    assert [t.text for t in spelling.tokens("Firma [FIRMA_096] liefert DN15 www.beispiel.de Kabel")] == \
        ["Firma", "liefert", "Kabel"]
    long_run = "." * 20000
    assert list(spelling.tokens(long_run)) == []  # masking stays linear on long runs without spaces


def test_real_dictionary_when_installed():
    hunspell = spelling.load_hunspell()
    if hunspell is None:
        pytest.skip("German hunspell dictionary or spylls not installed")
    spelling.use_checker(spelling.SpellChecker(hunspell=hunspell))
    findings = run(line(1, "Leistung", "Die erforderlichen Arbeiten führt der Auftragnehemer gemäß Elektotechnik "
                                      "aus und dokumentiert die Inbetriebnahme mit Fotos."))
    assert {f.evidence["suggestion"] for f in by_rule(findings, "L1.TEXT.TYPO")} == {"Auftragnehmer", "Elektrotechnik"}


def test_spelling_and_notation_variants_do_not_create_findings():
    findings = run(line(1, "Anschluss DN 100", "Der Anschluss und das Baustromkabel"),
                   line(2, "Anschluß DN100", "Der Anschluß und das Baustrom-Kabel", unit_raw="Stk"),
                   line(3, "Sektionaltor", "Das Sectionaltor und die Leistung"),
                   line(4, "Kabel 5x25"), line(5, "Kabel 5 x 25"))
    assert not [finding for finding in findings if finding.rule_id.startswith("L1.TEXT.")]


# ---------------------------------------------------------------- lexicon


def test_shipped_lexicon_has_no_corpus_typos():
    lexicon = spelling.load_lexicon()
    assert len(lexicon) > 2000
    assert {"auftragnehmer", "material", "anschluss", "sohlhöhe"} <= set(lexicon)
    assert not {"auftragnehemer", "erfoderlichen", "materail", "elektotechnik"} & set(lexicon)


def test_lexicon_project_grouping(tmp_path):
    data = tmp_path / "Data"
    assert build_lexicon.project_key(data / "LV_13_ELT.pdf", data) == "Data/LV"
    assert build_lexicon.project_key(data / "GAEB-[PROJEKT_004].X83", data) == "Data/[PROJEKT_004]"
    assert build_lexicon.project_key(data / "Leistungsverzeichnis_leer.pdf", data) == \
        build_lexicon.project_key(data / "Leistungsverzeichnis.pdf", data)
    test_data = tmp_path / "test-data"
    assert build_lexicon.project_key(test_data / "dbinfrago" / "10_massivbruecke" / "10.X83", test_data) == \
        "test-data/dbinfrago/10_massivbruecke"
    words = {f"wort{i}" for i in range(200)}
    assert build_lexicon.same_tender(words, words | {"extra"})
    assert not build_lexicon.same_tender(words, {f"anders{i}" for i in range(200)})
    assert not build_lexicon.same_tender(set(list(words)[:12]), words)  # too small to compare
