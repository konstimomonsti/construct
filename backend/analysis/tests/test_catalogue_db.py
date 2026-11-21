"""Integration coverage. Run against a migrated disposable PostgreSQL database."""

from concurrent.futures import ThreadPoolExecutor
import json
import os
from threading import Event
from uuid import uuid4

import pytest

from analysis.layer3.provider import FakeProvider

DSN = os.environ.get("CATALOGUE_TEST_DSN")
pytestmark = pytest.mark.skipif(not DSN, reason="Set CATALOGUE_TEST_DSN for PostgreSQL integration tests")


@pytest.fixture
def repository():
    import psycopg

    with psycopg.connect(DSN, autocommit=True) as conn:
        yield conn


def create_bom(conn):
    project = conn.execute("INSERT INTO project (name) VALUES ('Catalogue test') RETURNING id").fetchone()[0]
    return conn.execute("""
        INSERT INTO bom_version (project_id, package_code, version_no, title)
        VALUES (%s, 'pipes', 1, 'Pipe requirements') RETURNING id
    """, (project,)).fetchone()[0]


def position(conn, bom, order, text, quantity=10, unit="m", total_rule="include", **source):
    return conn.execute("""
        INSERT INTO bom_line (bom_version_id, line_code, sort_order, short_description, quantity, unit_code,
                              total_rule, source_document_id, alternative_for_line_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id
    """, (bom, str(order), order, text, quantity, unit, total_rule, source.get("document"), source.get("alternative"))).fetchone()[0]


def catalogue_product(conn, description):
    suffix = uuid4().hex
    with conn.transaction():
        category = conn.execute("""
            INSERT INTO product_category (name) VALUES ('Pipes')
            ON CONFLICT (name) DO UPDATE SET name = excluded.name RETURNING id
        """).fetchone()[0]
        supplier = conn.execute("INSERT INTO supplier (name) VALUES (%s) RETURNING id", (suffix,)).fetchone()[0]
        product_id = conn.execute("""
            INSERT INTO product (category_id, supplier_id, name, description, unit_code)
            VALUES (%s, %s, %s, %s, 'm') RETURNING id
        """, (category, supplier, description, description)).fetchone()[0]
        conn.execute("""
            INSERT INTO product_price (product_id, valid_from, currency, unit_price)
            VALUES (%s, '2025-01-01', 'EUR', 10)
        """, (product_id,))
    return str(product_id)


def add_source(conn, bom, role):
    source_id = conn.execute("""
        INSERT INTO source_document (project_id, filename, storage_key, sha256, format)
        SELECT project_id, %s, 'test', %s, 'gaeb_xml' FROM bom_version WHERE id = %s RETURNING id
    """, (role + ".x83", uuid4().hex.ljust(64, "0"), bom)).fetchone()[0]
    conn.execute("INSERT INTO bom_source (bom_version_id, source_document_id, role) VALUES (%s, %s, %s)",
                 (bom, source_id, role))
    return source_id


def sample(text, outcome="insufficient_evidence", **overrides):
    return {"outcome": outcome, "quote": text, "product_id": "", "name": "", "rationale": "Evidence reviewed"} | overrides


def by_line(report):
    return {item["line_code"]: item for item in report["occurrences"]}


def unique_size():
    # Distinct technical specifications keep fixtures independent in a disposable database.
    return str(1000 + uuid4().int % 1000000)


def test_stored_bom_review_grouping_and_persistence(repository):
    from analysis.catalogue.service import Catalogue
    from analysis.catalogue.store import Conflict

    conn = repository
    bom = create_bom(conn)
    assert Catalogue(conn).report(bom)["occurrences"] == []

    primary = add_source(conn, bom, "primary_scope")
    companion = add_source(conn, bom, "companion")
    rule_name = f"PE-HD pipe {unique_size()} x 4.6 mm"
    rule_id = catalogue_product(conn, rule_name)
    selected = position(conn, bom, 10, "Supply " + rule_name, document=primary)
    position(conn, bom, 20, "wie Position 10", quantity=250, unit="cm", document=primary)
    position(conn, bom, 10, "Supply " + rule_name, quantity=100, document=companion)
    position(conn, bom, 30, "Supply " + rule_name, quantity=40, total_rule="conditional", document=primary)
    position(conn, bom, 35, "Supply " + rule_name, quantity=90, alternative=selected, document=primary)
    position(conn, bom, 36, rule_name + " verlegen", quantity=10, document=primary)

    ambiguous_name = f"PP pipe DN {unique_size()} SN 8"
    suggested = catalogue_product(conn, ambiguous_name)
    corrected = catalogue_product(conn, ambiguous_name)
    for order in (40, 50):
        position(conn, bom, order, "Supply " + ambiguous_name, document=primary)

    new_name = f"PVC-U pipe DN {unique_size()} SN 4"
    invalid_name = f"PP pipe DN {unique_size()} SN 4"
    unresolved_name = f"PE-HD pipe {unique_size()} x 7.1 mm"
    for order, name in ((60, new_name), (70, invalid_name), (80, unresolved_name)):
        position(conn, bom, order, "Supply " + name, document=primary)

    fake = FakeProvider([
        sample(ambiguous_name, "existing_product", product_id=suggested),
        sample(new_name, "new_product", name=new_name),
        sample("Invented quote", "new_product", name=invalid_name),
        sample("", rationale="Supplier cannot be recovered"),
    ])
    service = Catalogue(conn, fake)
    first = service.process(bom)
    assert first["summary"]["provider_calls"] == 4
    grouped = next(group for group in first["groups"] if group["product"]["id"] == rule_id)
    assert grouped["selected_total"] == "12.50"
    assert {item["selection"] for item in grouped["occurrences"]} == {
        "selected", "conditional", "alternative", "companion",
    }
    assert len([item for item in first["occurrences"] if item["material_item_id"]]) == 4
    assert by_line(first)["70"]["evidence"]["validation_error"] == "Evidence quote is absent from the supplied source"

    # Re-open through a separate connection, then review using the current version of the decision.
    import psycopg

    with psycopg.connect(DSN, autocommit=True) as second_connection:
        restarted = Catalogue(second_connection, fake)
        second = restarted.process(bom)
        assert second["summary"]["provider_calls"] == 0
        state = by_line(second)
        assert state["40"]["decision_id"] == state["50"]["decision_id"]
        assert state["40"]["state"] == "pending"
        reviewed = restarted.review(bom, state["40"]["id"], "accept", "reviewer",
                                    expected_decision_id=state["40"]["decision_id"])
        accepted = by_line(reviewed)["40"]
        assert accepted["linked_product_id"] == suggested
        reviewed = restarted.review(bom, accepted["id"], "correct", "reviewer", product_id=corrected,
                                    expected_decision_id=accepted["decision_id"])
        for code in ("40", "50"):
            assert by_line(reviewed)[code]["linked_product_id"] == corrected
        assert len(restarted.history(bom, accepted["id"])["attempts"]) == 1
        with pytest.raises(Conflict):
            restarted.review(bom, accepted["id"], "reject", "reviewer",
                             expected_decision_id=accepted["decision_id"])

        pending = by_line(reviewed)["60"]
        pending_product = by_line(restarted.review(
            bom, pending["id"], "accept", "reviewer", expected_decision_id=pending["decision_id"],
        ))["60"]["product_id"]
        assert conn.execute("SELECT review_status, supplier_id, unit_code FROM product WHERE id = %s",
                            (pending_product,)).fetchone() == ("pending", None, None)
        # Equivalent specification across BOMs uses the original resolution, with its own quantity.
        equivalent = conn.execute("""
            INSERT INTO bom_version (project_id, package_code, version_no, title)
            SELECT project_id, package_code, 2, 'Equivalent specification' FROM bom_version WHERE id = %s RETURNING id
        """, (bom,)).fetchone()[0]
        position(conn, equivalent, 10, new_name.replace("pipe", "Rohr") + " liefern", quantity=7)
        assert by_line(restarted.process(equivalent))["10"]["product_id"] == pending_product

        unresolved = by_line(restarted.report(bom))["80"]
        unresolved = by_line(restarted.review(
            bom, unresolved["id"], "reject", "reviewer", expected_decision_id=unresolved["decision_id"],
        ))["80"]
        assert unresolved["state"] == "rejected"
        fake.responses.append(sample(""))
        retried = by_line(restarted.retry(bom, unresolved["id"], unresolved["decision_id"], unresolved["attempt_id"]))["80"]
        assert retried["attempt_id"] != unresolved["attempt_id"]
        assert retried["state"] == "pending"
        assert len(fake.requests) == 5
        with pytest.raises(Conflict):
            restarted.retry(bom, unresolved["id"], unresolved["decision_id"], unresolved["attempt_id"])

    # Commercial changes are outside the product identity, technical changes invalidate the decision.
    conn.execute("UPDATE product_price SET unit_price = 99 WHERE product_id = %s", (rule_id,))
    assert Catalogue(conn).report(bom)["groups"][0]["selected_total"] == "12.50"
    conn.execute("UPDATE product SET description = description || ' DN 9999' WHERE id = %s", (rule_id,))
    assert not any(group["product"]["id"] == rule_id for group in Catalogue(conn).report(bom)["groups"])
    assert any(item["state"] == "stale" for item in Catalogue(conn).report(bom)["occurrences"])
    after = Catalogue(conn).process(bom)
    assert not any(item["linked_product_id"] == rule_id for item in after["occurrences"])
    assert by_line(after)["60"]["linked_product_id"] == pending_product


def test_concurrent_workers_share_reservation_and_expired_lease_is_visible(repository):
    import psycopg

    from analysis.catalogue.service import Catalogue

    conn = repository
    bom = create_bom(conn)
    name = f"PE-HD pipe {unique_size()} x 13.1 mm"
    position(conn, bom, 10, "Supply " + name)

    started, release = Event(), Event()

    def respond(request):
        assert json.loads(request.prompt)["source_text"] == "Supply " + name
        started.set()
        assert release.wait(timeout=10)
        return sample("")

    fake = FakeProvider(respond)

    def process():
        with psycopg.connect(DSN, autocommit=True) as connection:
            return Catalogue(connection, fake).process(bom)

    with ThreadPoolExecutor(max_workers=2) as workers:
        leader = workers.submit(process)
        try:
            assert started.wait(timeout=10)
            follower = workers.submit(process).result(timeout=10)
            assert follower["summary"]["provider_calls"] == 0
            assert by_line(follower)["10"]["attempt_status"] == "running"
        finally:
            release.set()
        assert leader.result(timeout=10)["summary"]["provider_calls"] == 1
    assert len(fake.requests) == 1
    assert by_line(process())["10"]["attempt_status"] == "valid"

    # Simulate an interrupted worker that reserved the request but never saved a response.
    resolution = conn.execute("""
        SELECT resolution_id FROM catalogue_occurrence WHERE bom_version_id = %s
    """, (bom,)).fetchone()[0]
    latest = conn.execute("SELECT id FROM catalogue_attempt WHERE resolution_id = %s", (resolution,)).fetchone()[0]
    conn.execute("""
        INSERT INTO catalogue_attempt
            (resolution_id, previous_attempt_id, request_fingerprint, request, model_id, lease_until)
        VALUES (%s, %s, 'interrupted', '{}', 'fake', clock_timestamp() - interval '1 second')
    """, (resolution, latest))
    assert by_line(Catalogue(conn).report(bom))["10"]["attempt_status"] == "uncertain"
    assert by_line(process())["10"]["evidence"]["attempt_status"] == "uncertain"
    assert len(fake.requests) == 1
