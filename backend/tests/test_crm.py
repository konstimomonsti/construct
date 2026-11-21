"""Supplier relationships: categories for positions, supplier mapping, contact log and reminders."""

from datetime import datetime, timedelta, timezone
import os
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
import pytest

from analysis.layer3.provider import FakeProvider, ProviderError, ProviderUnavailable
import crm

DB = pytest.mark.skipif(not os.environ.get("CATALOGUE_TEST_DSN"), reason="Requires a disposable migrated PostgreSQL database")
OPTIONS = [
    {"id": "c-pipes", "name": "Pipes", "examples": ["PP Rohr DN 110"],
     "vocabulary": "PP Rohr DN 110 SN 8 Polypropylenrohr Freispiegelentwässerung Abwasserrohr"},
    {"id": "c-insulation", "name": "Insulation", "examples": ["Schaumglas"],
     "vocabulary": "Schaumglas Dämmplatte Wärmedämmung Mineralwolle"},
]


def position(identifier, short, long=""):
    return {"id": identifier, "oz": "01.01", "short": short, "long": long, "unit": "m"}


def test_keyword_fallback_picks_the_category_with_the_rarest_shared_words():
    results = crm.keyword_categories(
        [position("a", "Abwasserrohr verlegen", "Polypropylenrohr DN 110"), position("b", "Baustelle einrichten")],
        OPTIONS,
    )
    assert results[0]["category_id"] == "c-pipes"
    assert 0 < results[0]["confidence"] <= 0.75
    assert "abwasserrohr" in results[0]["reason"]
    assert results[1] is None


def test_keyword_fallback_matches_german_plurals_and_compounds():
    options = [{"id": "c-pipes", "name": "Rohre", "vocabulary": ""},
               {"id": "c-concrete", "name": "Beton", "vocabulary": "Betonstahl Matten"}]
    results = crm.keyword_categories(
        [position("a", "PP-Rohr DN 110 SN 8"), position("b", "Transportbeton C25/30"), position("c", "Rohrleitung spülen"),
         position("d", "Oberboden abtragen")],
        options,
    )
    assert [result and result["category_id"] for result in results] == ["c-pipes", "c-concrete", "c-pipes", None]
    assert results[1]["reason"] == "Shared words: beton"


def test_ai_categories_are_limited_to_known_names_and_indexes():
    provider = FakeProvider([{"assignments": [
        {"index": 0, "category": "Insulation", "confidence": 1.7, "reason": "Foam glass boards"},
        {"index": 1, "category": "none", "confidence": 0.9, "reason": "Labour only"},
        {"index": 2, "category": "Made up", "confidence": 0.9, "reason": "x"},
        {"index": 7, "category": "Pipes", "confidence": 0.9, "reason": "x"},
        {"index": 0, "category": "Pipes", "confidence": 0.9, "reason": "duplicate"},
    ]}])
    positions = [position("a", "Schaumglas"), position("b", "Baustelle einrichten"), position("c", "Unklar")]
    results = crm.ai_categories(provider, positions, OPTIONS)
    assert results == [{"category_id": "c-insulation", "confidence": 1.0, "reason": "Foam glass boards"}, False, None]
    request = provider.requests[0]
    enum = request.schema["properties"]["assignments"]["items"]["properties"]["category"]["enum"]
    assert enum == ["Pipes", "Insulation", "none"]
    assert "Schaumglas" in request.prompt and "example_products" in request.prompt


def test_items_and_timestamps_are_validated():
    assert crm.clean_items([{"position_id": "p1", "short": " Rohr ", "qty": 12.5, "unit": "m", "extra": "x"}]) == [
        {"position_id": "p1", "short": "Rohr", "unit": "m", "qty": 12.5}]
    with pytest.raises(ValueError):
        crm.clean_items("nope")
    assert crm.timestamp({"due_at": "2026-12-01T10:00:00Z"}, "due_at").tzinfo is not None
    assert crm.timestamp({"due_at": "2026-12-01"}, "due_at").tzinfo is timezone.utc
    with pytest.raises(ValueError):
        crm.timestamp({"due_at": "tomorrow"}, "due_at")
    with pytest.raises(ValueError):
        crm.clean_positions([{"short": "missing id"}])


@pytest.fixture
def db():
    with psycopg.connect(os.environ["CATALOGUE_TEST_DSN"], autocommit=True, row_factory=dict_row) as connection:
        with connection.transaction(force_rollback=True):
            yield connection


def seed(connection):
    tag = str(uuid4())[:8]
    pipes = connection.execute("INSERT INTO product_category (name) VALUES (%s) RETURNING id",
                               (f"Pipes {tag}",)).fetchone()["id"]
    insulation = connection.execute("INSERT INTO product_category (name) VALUES (%s) RETURNING id",
                                    (f"Insulation {tag}",)).fetchone()["id"]
    stocked = connection.execute("INSERT INTO supplier (name, email) VALUES (%s, 'a@example.com') RETURNING id",
                                 (f"Rohrhandel {tag}",)).fetchone()["id"]
    mapped = connection.execute("INSERT INTO supplier (name, email) VALUES (%s, 'b@example.com') RETURNING id",
                                (f"Dämmstoffe {tag}",)).fetchone()["id"]
    product = connection.execute(
        """INSERT INTO product (supplier_id, category_id, name, description, unit_code, review_status)
           VALUES (%s, %s, %s, 'Polypropylenrohr für Freispiegelentwässerung', 'm', 'approved') RETURNING id""",
        (stocked, pipes, f"PP Rohr DN 110 {tag}"),
    ).fetchone()["id"]
    connection.execute(
        """INSERT INTO product (supplier_id, category_id, name, description, unit_code, review_status)
           VALUES (%s, %s, %s, 'Schaumglas Dämmplatte', 'm2', 'approved')""",
        (stocked, insulation, f"Schaumglas {tag}"),
    )
    return {"tag": tag, "pipes": str(pipes), "insulation": str(insulation), "stocked": str(stocked),
            "mapped": str(mapped), "product": str(product)}


@DB
def test_supplier_mapping_combines_products_and_explicit_categories(db):
    data = seed(db)
    crm.set_supplier_categories(db, {"supplier_id": data["mapped"], "category_ids": [data["insulation"]]})
    mapping = {row["id"]: row for row in crm.supplier_mapping(db)}
    assert set(mapping[data["stocked"]]["category_ids"]) == {data["pipes"], data["insulation"]}
    assert mapping[data["stocked"]]["explicit_category_ids"] == []
    assert mapping[data["mapped"]]["category_ids"] == [data["insulation"]]
    assert mapping[data["mapped"]]["explicit_category_ids"] == [data["insulation"]]
    db.execute("UPDATE supplier SET archived_at=now() WHERE id=%s", (data["mapped"],))
    assert data["mapped"] not in {row["id"] for row in crm.supplier_mapping(db)}
    with pytest.raises(LookupError):
        crm.set_supplier_categories(db, {"supplier_id": str(uuid4()), "category_ids": []})


@DB
def test_categories_come_from_user_then_catalogue_then_ai(db):
    data = seed(db)
    bill = f"crm-{data['tag']}"
    db.execute("INSERT INTO workspace_sync (workspace) VALUES ('default') ON CONFLICT DO NOTHING")
    db.execute("""INSERT INTO workspace_record (workspace, collection, record_id, value, revision)
                  VALUES ('default', 'userLists', %s, '{}', 0)""", (bill,))
    db.execute("INSERT INTO workspace_catalogue_run (workspace, list_id, state) VALUES ('default', %s, 'ready')", (bill,))
    db.execute(
        """INSERT INTO workspace_catalogue_position (workspace, list_id, position_id, state, input, product)
           VALUES ('default', %s, 'matched', 'matched', '{}', %s)""",
        (bill, psycopg.types.json.Jsonb({"id": data["product"], "name": "PP Rohr", "category": f"Pipes {data['tag']}"})),
    )
    positions = [position("matched", "PP Rohr DN 110 liefern"), position("unknown", "Foamglas-Platten 120 mm"),
                 position("labour", "Baustelle einrichten"), position("empty", "")]

    def answer(request):
        assert "Foamglas" in request.prompt and "PP Rohr DN 110 liefern" not in request.prompt
        assert "empty" not in request.prompt
        return {"assignments": [
            {"index": 0, "category": f"Insulation {data['tag']}", "confidence": 0.82, "reason": "Foam glass boards"},
            {"index": 1, "category": "none", "confidence": 0.9, "reason": "Site setup"},
        ]}

    provider = FakeProvider(answer)
    view = crm.categorize(db, "default", {"list_id": bill, "positions": positions}, provider_factory=lambda: provider)
    by_id = {entry["id"]: entry for entry in view["positions"]}
    assert by_id["matched"]["source"] == "catalogue" and by_id["matched"]["category_id"] == data["pipes"]
    assert by_id["matched"]["product"]["id"] == data["product"]
    assert by_id["unknown"]["source"] == "ai" and by_id["unknown"]["category_id"] == data["insulation"]
    assert by_id["unknown"]["confidence"] == 0.82
    assert by_id["labour"]["category_id"] is None
    assert view["run"]["method"] == "ai" and view["run"]["assigned"] == 1 and view["run"]["without_category"] == 1

    crm.set_position_category(db, "default", {"list_id": bill, "position_id": "matched", "category_id": data["insulation"]})
    crm.set_position_category(db, "default", {"list_id": bill, "position_id": "unknown", "category_id": data["pipes"]})
    view = crm.sourcing(db, "default", {"list_id": bill, "positions": positions})
    by_id = {entry["id"]: entry for entry in view["positions"]}
    assert by_id["matched"]["source"] == "user" and by_id["matched"]["category_id"] == data["insulation"]
    # A later AI run never replaces the user's choice.
    provider = FakeProvider(lambda request: {"assignments": [
        {"index": 0, "category": f"Insulation {data['tag']}", "confidence": 0.9, "reason": "x"}]})
    view = crm.categorize(db, "default", {"list_id": bill, "positions": positions, "redo": True},
                          provider_factory=lambda: provider)
    assert {entry["id"]: entry for entry in view["positions"]}["unknown"]["category_id"] == data["pipes"]
    crm.set_position_category(db, "default", {"list_id": bill, "position_id": "unknown", "category_id": None})
    view = crm.sourcing(db, "default", {"list_id": bill, "positions": positions})
    assert {entry["id"]: entry for entry in view["positions"]}["unknown"]["source"] is None


@DB
def test_failed_model_batches_fall_back_to_keywords(db):
    data = seed(db)
    bill = f"crm-{data['tag']}"
    provider = FakeProvider([ProviderError("timeout")])
    view = crm.categorize(db, "default", {"list_id": bill, "positions": [position("p", "Polypropylenrohr verlegen")]},
                          provider_factory=lambda: provider)
    entry = view["positions"][0]
    assert entry["category_id"] == data["pipes"] and entry["source"] == "keyword"
    assert view["run"]["fallback"] == 1

    def unavailable():
        raise ProviderUnavailable("no key")

    view = crm.categorize(db, "default", {"list_id": bill + "x", "positions": [position("p", "Schaumglas Dämmplatte")]},
                          provider_factory=unavailable)
    assert view["run"]["method"] == "keyword" and view["positions"][0]["category_id"] == data["insulation"]


@DB
def test_requests_answers_and_reminders(db):
    data = seed(db)
    sent_at = datetime.now(timezone.utc) - timedelta(days=3)
    logged = crm.log_events(db, {"events": [
        {"kind": "rfq_sent", "party_kind": "supplier", "party_id": data["stocked"], "list_id": "bill-1",
         "list_title": "Schule Nord", "subject": "Preisanfrage", "occurred_at": sent_at.isoformat(),
         "due_at": (sent_at + timedelta(days=2)).isoformat(),
         "items": [{"position_id": "p1", "short": "PP Rohr", "qty": 20, "unit": "m"}]},
        {"kind": "rfq_sent", "party_kind": "supplier", "party_id": data["mapped"], "list_id": "bill-1",
         "occurred_at": sent_at.isoformat(), "due_at": (sent_at + timedelta(days=7)).isoformat()},
    ]}, user="tester")["events"]
    assert logged[0]["created_by"] == "tester" and logged[0]["items"][0]["qty"] == 20
    reminders = crm.overview(db)["reminders"]
    mine = [row for row in reminders if row["party_id"] in {data["stocked"], data["mapped"]}]
    assert len(mine) == 2 and mine[0]["list_title"] == "Schule Nord"

    reply = crm.log_events(db, {"kind": "offer_received", "party_kind": "supplier", "party_id": data["stocked"],
                                "occurred_at": (sent_at + timedelta(hours=30)).isoformat()})["events"][0]
    assert reply["request_id"] == logged[0]["id"]
    assert (reply["list_id"], reply["list_title"]) == ("bill-1", "Schule Nord"), "an answer belongs to its request's bill"

    stats = {row["id"]: row for row in crm.overview(db)["parties"]}
    stocked, mapped = stats[data["stocked"]], stats[data["mapped"]]
    assert (stocked["requests"], stocked["answered"], stocked["open"], stocked["overdue"]) == (1, 1, 0, 0)
    assert stocked["avg_response_hours"] == 30.0
    assert (mapped["requests"], mapped["answered"], mapped["open"], mapped["overdue"]) == (1, 0, 1, 0)
    assert set(stocked["category_ids"]) == {data["pipes"], data["insulation"]}
    open_reminders = [row for row in crm.overview(db)["reminders"] if row["party_id"] == data["stocked"]]
    assert open_reminders == []

    log = crm.events(db, {"party_id": data["stocked"]})["events"]
    assert [row["kind"] for row in log] == ["offer_received", "rfq_sent"]
    assert log[1]["response_hours"] == 30.0 and log[1]["party_name"].startswith("Rohrhandel")

    crm.delete_event(db, {"id": reply["id"]})
    assert {row["id"]: row for row in crm.overview(db)["parties"]}[data["stocked"]]["open"] == 1

    reminder = crm.save_reminder(db, {"party_kind": "supplier", "party_id": data["mapped"],
                                      "due_at": "2026-12-01T09:00:00Z", "note": "Call back"})
    done = crm.save_reminder(db, {"id": reminder["id"], "done": True})
    assert done["done_at"] is not None
    with pytest.raises(LookupError):
        crm.log_events(db, {"kind": "note", "party_kind": "subcontractor", "party_id": data["stocked"]})
    with pytest.raises(ValueError):
        crm.log_events(db, {"kind": "shout", "party_kind": "supplier", "party_id": data["stocked"]})
