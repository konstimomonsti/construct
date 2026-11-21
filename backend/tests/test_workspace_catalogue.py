"""Regression coverage for catalogue decisions and cited research."""

import os
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
import pytest

import workspace

import workspace_catalogue as catalogue


def test_catalogue_match_respects_input_unit_and_ambiguity():
    item = {
        "id": UUID(int=1), "name": "Schaumglas", "category": "Insulation",
        "unit_code": "m²", "tender_units": ["m2"], "description": "Rigid glass boards",
    }
    matcher = catalogue.ProductMatcher([item])
    position = {"short": "Schaumglas", "unit": "m2"}
    assert catalogue.position_match(position, [], matcher) == (
        "matched", {"id": str(item["id"]), "name": "Schaumglas", "category": "Insulation"},
    )
    assert catalogue.position_match({**position, "unit": "m³"}, [], matcher) == ("queued", None)
    assert catalogue.position_match({**position, "long": "Loose fill"}, [], matcher) == ("queued", None)
    ambiguous = catalogue.ProductMatcher([item, {**item, "id": UUID(int=2)}])
    assert catalogue.position_match(position, [], ambiguous) == ("queued", None)


@pytest.mark.parametrize(("short", "long", "matched"), [
    ("Lieferung DN110 SN8: PP Rohr", "", True),
    ("PP Rohr DN 110 SN 8", "PP Rohr für Freispiegelentwässerung, Lieferung auf die Baustelle", True),
    ("PP Abwasserrohr DN 110 SN 8", "", True),
    ("PP Rohr DN 110 SN 4", "", False),
    ("PP Rohr DN 110 SN 8", "PP Rohr für Druckentwässerung", False),
    ("PP Rohr DN 110 SN 8", "PP Rohr für Freispiegelentwässerung, Material PVC", False),
    ("PP Rohr DN 110 SN 8 ohne Dichtung", "", False),
    ("PP Rohr DN 110", "", False),
])
def test_match_pipe_spec_without_saved_source(short, long, matched):
    item = {
        "id": UUID(int=1), "name": "PP Rohr DN 110 SN 8", "category": "Pipes",
        "unit_code": "m", "tender_units": [], "description": "PP Rohr für Freispiegelentwässerung",
    }
    position = {"short": short, "long": long, "unit": "m"}
    assert bool(catalogue.ProductMatcher([item]).match(position)) is matched


def test_unqualified_reference_does_not_choose_between_pipe_variants():
    item = {
        "id": UUID(int=1), "name": "GGG Muffendruckrohr DN 100", "category": "Pipes",
        "unit_code": "m", "tender_units": [], "description": "",
    }
    fixed = {**item, "id": UUID(int=2), "name": item["name"] + " mit Zugsicherung"}
    matcher = catalogue.ProductMatcher([item, fixed])
    assert matcher.match({"short": "wie vor, jedoch GGG Muffendruckrohre DN 100", "unit": "m"}) is None
    assert matcher.match({"short": fixed["name"], "unit": "m"}) == fixed


def test_wrapped_specification_ignores_pdf_continuation_but_preserves_changed_technical_detail():
    name = "Spezialplatte Wärmedämmung Nr 110"
    detail = (
        "Wärmedämmplatte zur Montage auf dem ebenen Untergrund gemäß Planung. "
        "Die Platte trägt eine Schutzschicht aus Edelstahl und ist fugenlos zu befestigen."
    )
    wrapped = detail.replace("Die Platte", "\n- Fortsetzung auf nächster Seite - Übertrag: ..........\nDie Platte")
    item = {"id": UUID(int=1), "name": name, "description": detail, "unit_code": "m²",
            "tender_units": [], "category": "Insulation"}
    position = {"short": name, "long": f"{name}\n{wrapped}", "unit": "m2"}
    matcher = catalogue.ProductMatcher([item])
    assert matcher.match(position) == item
    assert matcher.match({**position, "long": position["long"].replace("Edelstahl", "Aluminium")}) is None


def test_short_generic_title_does_not_identify_a_sized_catalogue_product():
    item = {
        "id": UUID(int=1), "name": "Rohrschelle für Stahlrohr", "category": "Pipes",
        "unit_code": "piece", "tender_units": [], "description": "Rohrschelle für Stahlrohr DN 110",
    }
    assert catalogue.ProductMatcher([item]).match({"short": item["name"], "unit": "St"}) is None


@pytest.mark.skipif(not os.environ.get("CATALOGUE_TEST_DSN"), reason="Requires a disposable migrated PostgreSQL database")
def test_workspace_worker_matches_an_upload_without_source_links(monkeypatch):
    def no_links(connection, digest):
        assert digest is None
        return {}

    monkeypatch.setattr(catalogue, "source_links", no_links)
    with psycopg.connect(os.environ["CATALOGUE_TEST_DSN"], autocommit=True, row_factory=dict_row) as connection:
        with connection.transaction(force_rollback=True):
            kind = f"Benchmark-{uuid4()}"
            category = connection.execute(
                "INSERT INTO product_category (name) VALUES (%s) RETURNING id", (kind,)
            ).fetchone()["id"]
            product = connection.execute(
                """INSERT INTO product (name, description, unit_code, category_id, review_status)
                VALUES (%s, 'Polypropylenrohr für Freispiegelentwässerung', 'm', %s, 'pending') RETURNING id""",
                (f"{kind} PP Rohr DN 110 SN 8", category),
            ).fetchone()["id"]
            connection.execute("INSERT INTO workspace_sync (workspace) VALUES ('default') ON CONFLICT DO NOTHING")
            list_id = f"product-match-{uuid4()}"
            workspace.apply(connection, {"changes": {"userLists": {"set": {list_id: {
                "fileName": "unseen.csv", "source": {"kind": "csv"}, "userCreated": True,
                "positions": [
                    {"id": "match", "short": f"{kind} PP-Rohr DN110 SN8 liefern", "unit": "m"},
                    {"id": "variant", "short": f"{kind} PP-Rohr DN110 SN4 liefern", "unit": "m"},
                ],
            }}}}})
            assert catalogue.classify_next(connection)
            report = catalogue.status(connection, "default", list_id)
            assert report["state"] == "ready"
            assert report["positions"]["match"]["product"]["id"] == str(product)
            assert report["positions"]["variant"]["product"] is None


def test_research_fetches_article_evidence_and_ignores_unrelated_search_hits(monkeypatch):
    paths = []

    def wiki(path):
        paths.append(path)
        if "search/page" in path:
            return {"pages": [{"title": "Other material", "key": "Other_material"},
                              {"title": "Schaumglas", "key": "Schaumglas"}]}
        assert path.endswith("/Schaumglas")
        return {"type": "standard", "extract": "Schaumglas is manufactured from foamed glass."}

    monkeypatch.setattr(catalogue, "wiki_json", wiki)
    assert catalogue.research("Schaumglas [PROJECT NAME]") == {
        "name": "Schaumglas", "description": "Schaumglas is manufactured from foamed glass.",
        "url": "https://de.wikipedia.org/wiki/Schaumglas", "source": "Wikipedia",
    }
    assert len(paths) == 2 and "project" not in paths[0].lower()
    assert catalogue.research("Unknown product") is None


def test_seed_matching_allows_crlf_but_not_different_source_content():
    class Connection:
        def execute(self, query, params):
            if query.startswith("SELECT 1"):
                return type("EmptyCursor", (), {"fetchone": lambda self: None})()
            return [{"sha256": "seed-sha", "content": b"00 original\r\n21 offer\r\n"}]

    connection = Connection()
    assert catalogue.seeded_offer_hash(connection, "offer.D84", "upload-sha", b"00 original\n21 offer\n") == "seed-sha"
    assert catalogue.seeded_offer_hash(connection, "offer.D84", "upload-sha", b"00 original\n21 other\n") == "upload-sha"


def test_companion_alignment_needs_more_than_a_shared_position_number():
    from workspace_product_companions import aligned_positions, compatible_specification

    first = [{"oz": f"01.{i}", "qty": i, "unit": "m", "short": f"Kabel DN{i}"} for i in range(1, 23)]
    second = [{**row, "short": f"Rohr DN{index} PVC"} for index, row in enumerate(first, 1)]
    assert not aligned_positions(first, second)
    same = [{**row, "short": row["short"] + " liefern"} for row in first]
    assert len(aligned_positions(first, same)) == 22
    assert not compatible_specification(
        {"short": "Kabel X100", "long": "Mantel aus PVC"},
        {"short": "Kabel X100", "long": "Mantel aus PP"},
    )
    assert not compatible_specification(
        {"short": "Rohr", "long": "Druckstufe PN 16"},
        {"short": "Rohr", "long": "Druckstufe PN 10"},
    )


def test_small_model_requires_a_valid_verdict_and_verbatim_evidence():
    from analysis.layer3.provider import FakeProvider
    from workspace_product_ai import adjudicate, companion_check

    item = {"id": "known", "name": "Kabel A2Y-F 20 x 2", "category": "Cables"}
    check = companion_check({}, {"position": {"short": item["name"]}, "product": item})
    good = {"case": 0, "compatible": True, "quote": "Kabel A2Y-F 20 x 2"}
    responses = FakeProvider([
        {"verdicts": [good]},
        {"verdicts": [{**good, "quote": "Unseen catalogue text"}]},
        {"verdicts": [good, good]},
        {"verdicts": [{**good, "compatible": False}]},
    ])
    assert adjudicate(responses, [check]) == [item]
    assert [adjudicate(responses, [check]) for _ in range(3)] == [[None], [None], [None]]


@pytest.mark.skipif(not os.environ.get("CATALOGUE_TEST_DSN"), reason="Requires a disposable migrated PostgreSQL database")
def test_model_review_uses_independently_uploaded_copies_and_rechecks_removal(monkeypatch):
    from analysis.layer3.provider import FakeProvider

    monkeypatch.setenv("BILLBUILD_CATALOGUE_MODEL", "claude-haiku-5-5")
    monkeypatch.setenv("BILLBUILD_WEB_RESEARCH", "0")
    prefix = f"matchlab-{uuid4()}"
    name = f"{prefix} Druckrohr DN 110"
    provider = FakeProvider([
        {"verdicts": [{"case": 0, "compatible": True, "quote": "Druckrohr DN 110"}]},
    ])
    monkeypatch.setattr(catalogue, "catalogue_provider", lambda: provider)
    with psycopg.connect(os.environ["CATALOGUE_TEST_DSN"], autocommit=True, row_factory=dict_row) as conn:
        with conn.transaction(force_rollback=True):
            category = conn.execute("INSERT INTO product_category(name) VALUES (%s) RETURNING id", (prefix,)).fetchone()
            product = conn.execute(
                """INSERT INTO product (name, description, unit_code, category_id, review_status)
                   VALUES (%s, %s, 'm', %s, 'pending') RETURNING id""",
                (name, name, category["id"]),
            ).fetchone()
            original = [{"id": str(i), "oz": f"1.{i}", "qty": i, "up": 111 + i, "unit": "m"}
                        for i in range(1, 21)]
            companion = [{**row, "short": name if i == 0 else f"Unknown {prefix} {i}"}
                         for i, row in enumerate(original)]
            src = {"folderId": prefix, "source": {"kind": "pdf"}, "userCreated": True}
            first, second = prefix + "-offer", prefix + "-printout"

            def put(record_id, filename, positions):
                workspace.apply(conn, {"changes": {"userLists": {"set": {
                    record_id: {**src, "fileName": filename, "positions": positions},
                }}}})

            put(first, "Offer.D84", original)
            assert catalogue.classify_next(conn)
            assert catalogue.status(conn, "default", first)["positions"]["1"]["state"] == "needs_description"
            put(second, "Tender PDF.pdf", companion)
            for _ in range(2):
                assert catalogue.classify_next(conn)
            queued = catalogue.status(conn, "default", first)["positions"]["1"]
            assert queued["state"] == "queued" and queued["model_review"]
            assert catalogue.research_next(conn)
            assert catalogue.status(conn, "default", first)["positions"]["1"]["product"]["id"] == str(product["id"])
            workspace.apply(conn, {"changes": {"userLists": {"delete": [second]}}})
            assert catalogue.classify_next(conn)
            assert catalogue.status(conn, "default", first)["positions"]["1"]["state"] == "needs_description"
            assert not catalogue.research_next(conn)


def test_implicit_reference_inherits_the_variant_only_within_its_numbered_section():
    from workspace_product_references import PositionReferences

    references = PositionReferences()
    name = "Muffendruckrohr TYT DN 300 mit"
    references.resolve({"oz": "1.1.10", "short": name, "long": name + "\nZugsicherung", "unit": "m"})
    dependent = {"oz": "1.1.20", "short": "wie vor, jedoch Muffendruckrohr TYT DN 250", "unit": "m"}
    assert references.resolve(dependent)["short"] == "muffendruckrohr tyt dn 250 mit zugsicherung"
    assert references.resolve({**dependent, "oz": "1.2.20"})["short"] == dependent["short"]
    assert references.resolve({**dependent, "unit": "St"})["short"] == dependent["short"]


def test_matching_an_excerpt_cannot_override_a_changed_pressure_or_material():
    title = "Druckrohr PE100 für Trinkwasser"
    text = "Rohr für den dauerhaft erdverlegten Betrieb der Leitung aus Polyethylen in Trinkwasseranlagen mit PN 10."
    product = {"id": "p", "category": "Pipes", "unit_code": "m", "tender_units": [], "name": title, "description": text}
    matcher = catalogue.ProductMatcher([product])
    for amendment in (" Druckstufe PN 16.", " Mantel aus Aluminium."):
        assert matcher.match({"short": title, "long": text + amendment, "unit": "m"}) is None


def test_dimension_only_reference_matches_the_product_with_the_revised_height():
    from workspace_product_references import PositionReferences

    refs = PositionReferences()
    refs.resolve({"oz": "2.1.10", "short": "Ausgleichsring liefern und einbauen / Höhe = 4 cm", "unit": "St"})
    later = {"oz": "2.1.20", "short": "wie vor, jedoch Höhe = 8 cm", "unit": "St"}
    actual = refs.resolve(later)
    assert actual["short"] == "ausgleichsring höhe 8 cm"
    products = [
        {"id": str(n), "name": f"Ausgleichsring, Höhe {n} cm", "description": f"Höhe {n} cm",
         "unit_code": "St", "tender_units": [], "category": "Rings"} for n in (4, 8, 10)
    ]
    assert catalogue.ProductMatcher(products).match(actual)["id"] == "8"


def test_printed_price_placeholders_and_position_banners_do_not_replace_the_product_name():
    name = "Stahlwinkel für Wandauflager"
    detail = "Stahlwinkel verzinkt mit Befestigungsschrauben"
    item = {"id": "angle", "name": name, "description": detail + " 1,000 St ......................... .........................",
            "unit_code": "St", "tender_units": [], "category": "Fittings"}
    position = {"short": "*** Bedarfsposition ohne GB", "long": name + "\n" + detail, "unit": "St"}
    matcher = catalogue.ProductMatcher([item])
    assert matcher.match(position) == item
    assert matcher.match({**position, "long": name + "\nStahlwinkel unverzinkt"}) is None


def test_quantityless_summary_requires_distinct_title_witnesses():
    from workspace_product_companions import aligned_positions

    summary = [{"oz": f"01.{i}", "qty": 0, "unit": "m", "short": f"Kabel Typ {i}"} for i in range(1, 22)]
    full = [{**row, "qty": i} for i, row in enumerate(summary, 1)]
    assert len(aligned_positions(summary, full)) == len(summary)
    template = [{**row, "short": "Kabel Standard"} for row in summary]
    assert not aligned_positions(template, [{**row, "qty": 10} for row in template])


def test_aligned_summary_heading_needs_a_local_identifier_and_preserves_its_dimensions():
    from workspace_product_companions import compatible_specification

    full = {"short": "Asphalttragschicht AC 32 T N herstellen", "long": "Asphalttragschicht, Einbaudicke 14 cm"}
    assert compatible_specification({"short": "Asphaltschicht (14 cm) herstellen"}, full, summary=True)
    assert not compatible_specification({"short": "Asphaltschicht (12 cm) herstellen"}, full, summary=True)
    assert not compatible_specification({"short": "Deckschicht (14 cm) herstellen"}, full, summary=True)


def test_direct_model_review_checks_both_quotes_and_leaves_identical_products_tied():
    from analysis.layer3.provider import FakeProvider
    from workspace_product_ai import adjudicate, catalogue_check

    item = {"id": "known", "name": "Stahlwinkel 60 mm", "category": "Fittings", "unit_code": "St",
            "tender_units": [], "description": "Stahlwinkel für die Montage an der Wand im Innenraum mit zwei zugelassenen Schrauben nach Montageplan."}
    position = {"short": item["name"], "unit": "St",
                "long": "Stahlwinkel zur Montage an der Wand im Innenraum mit zwei zugelassenen Schrauben nach Montageplan."}
    assert catalogue.ProductMatcher([item]).review_candidate(position) == item
    assert catalogue.ProductMatcher([item, {**item, "id": "duplicate"}]).review_candidate(position) is None

    check = catalogue_check(position, item)
    base = {"case": 0, "compatible": True, "quote": "Stahlwinkel für die Montage"}
    answers = FakeProvider([
        {"verdicts": [base]},
        {"verdicts": [{**base, "original_quote": "Stahlwinkel für die Montage"}]},
        {"verdicts": [{**base, "original_quote": "Stahlwinkel zur Montage"}]},
    ])
    assert [adjudicate(answers, [check]) for _ in range(3)] == [[None], [None], [check["product"]]]


def test_parent_specification_can_match_separately_listed_components_without_ignoring_overrides():
    title = "Fertigbogen DN 100 mit Isolierung"
    description = (
        "Fertigbogen aus Stahl gemäss DIN mit werkseitiger standardisierter Isolierung "
        "für die erdverlegte Fernwärmeleitung und einer Druckstufe PN 10."
    )
    item = {"id": "elbow", "name": title, "description": description,
            "unit_code": "St", "tender_units": [], "category": "Fittings"}
    matcher = catalogue.ProductMatcher([item])
    position = {"short": title, "unit": "St", "long": description + "\nUnterbeschreibung 1:\nMessleitung 2 m"}
    assert matcher.match(position) == item
    assert matcher.match({**position, "long": description + "\nUnterbeschreibung 1:\nAbweichend PN 16."}) is None


def test_catalogue_unit_can_be_read_from_the_original_unpriced_schedule_layout():
    title = "Kabelverlängerung unter der Bodenplatte"
    item = {"id": "work", "name": title,
            "description": title + " 1,000 PSCH ......................... .........................",
            "unit_code": None, "tender_units": [], "category": "Electrical"}
    matcher = catalogue.ProductMatcher([item])
    assert matcher.match({"short": title, "unit": "Psch"}) == item
    assert matcher.match({"short": title, "unit": "m"}) is None


def test_aligned_copy_can_use_full_specification_when_title_is_abbreviated():
    from workspace_product_companions import compatible_specification

    body = (
        "Einsetzbar für dieses Bauvorhaben und die vorgesehene Umgebung in einem frostfreien "
        "Innenraum mit zugänglichem Anschluss. Ausführung aus nichtrostendem Stahl und mit "
        "werkseitiger Kennzeichnung des Herstellers."
    )
    short = {"short": "Abgekürzte Position DN 100", "long": body}
    full = {"short": "Absperrklappe mit Messstutzen DN 100", "long": body}
    assert compatible_specification(short, full)
    assert not compatible_specification(short, {**full, "short": "Absperrklappe mit Messstutzen DN 200"})
