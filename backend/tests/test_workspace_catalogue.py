"""Regression coverage for catalogue decisions and cited research."""

from uuid import UUID

import workspace_catalogue as catalogue


def test_catalogue_match_respects_input_unit_and_ambiguity():
    item = {
        "id": UUID(int=1), "name": "Schaumglas", "category": "Insulation",
        "unit_code": "m²", "tender_units": ["m2"], "description": "Rigid glass boards",
    }
    name = catalogue.words(item["name"])
    position = {"short": "Schaumglas", "unit": "m2"}
    assert catalogue.position_match(position, [], {name: [item]}) == (
        "matched", {"id": str(item["id"]), "name": "Schaumglas", "category": "Insulation"},
    )
    assert catalogue.position_match({**position, "unit": "m³"}, [], {name: [item]}) == ("queued", None)
    assert catalogue.position_match({**position, "long": "Loose fill"}, [], {name: [item]}) == ("queued", None)
    assert catalogue.position_match(position, [], {name: [item, {**item, "id": UUID(int=2)}]}) == ("queued", None)


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
