"""Activity prices: ours and the subcontractors' offers, read by tender position code."""

import os
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
import pytest

import catalogues

DB = pytest.mark.skipif(not os.environ.get("CATALOGUE_TEST_DSN"), reason="Requires a disposable migrated PostgreSQL database")


def add_activity(conn, code, name, unit="m"):
    return conn.execute(
        "INSERT INTO activity (code, name, unit_code) VALUES (%s, %s, %s) RETURNING id", (code, name, unit),
    ).fetchone()["id"]


def add_price(conn, activity, price, subcontractor=None, valid_from="2020-01-01", valid_until=None):
    conn.execute(
        """INSERT INTO activity_price (activity_id, subcontractor_id, valid_from, valid_until, currency, unit_price)
           VALUES (%s, %s, %s, %s, 'EUR', %s)""",
        (activity, subcontractor, valid_from, valid_until, price),
    )


@pytest.mark.parametrize("codes", ["", " , ", ",".join(f"c{i}" for i in range(201)), "x" * 41])
def test_activity_codes_are_validated(codes):
    with pytest.raises(ValueError):
        catalogues.read_activities(None, {"codes": codes})


@DB
def test_activity_read_returns_own_and_subcontractor_prices_that_are_valid_today():
    prefix = f"act-{uuid4().hex[:8]}"
    with psycopg.connect(os.environ["CATALOGUE_TEST_DSN"], autocommit=True, row_factory=dict_row) as conn:
        with conn.transaction(force_rollback=True):
            sub = conn.execute(
                "INSERT INTO subcontractor (name, trade) VALUES (%s, 'Kabeltiefbau') RETURNING id", (f"{prefix} Tiefbau",),
            ).fetchone()["id"]
            archived = conn.execute(
                "INSERT INTO subcontractor (name, trade, archived_at) VALUES (%s, 'x', now()) RETURNING id",
                (f"{prefix} Archiv",),
            ).fetchone()["id"]
            both = add_activity(conn, f"{prefix}.1", "Kabel ausbauen")
            add_price(conn, both, "2.40")
            add_price(conn, both, "1.90", sub)
            add_price(conn, both, "9.99", sub, valid_from="2019-01-01")  # superseded by the newer price of this sub
            add_price(conn, both, "0.10", archived)  # archived subcontractors never price
            expired = add_activity(conn, f"{prefix}.2", "Abgelaufen")
            add_price(conn, expired, "5", sub, valid_until="2020-12-31")
            future = add_activity(conn, f"{prefix}.3", "Noch nicht gültig")
            add_price(conn, future, "5", valid_from="2999-01-01")
            retired = add_activity(conn, f"{prefix}.4", "Archiviert")
            add_price(conn, retired, "5")
            conn.execute("UPDATE activity SET archived_at = now() WHERE id = %s", (retired,))
            codes = ",".join(f"{prefix}.{n}" for n in range(1, 6))

            rows = catalogues.read_activities(conn, {"codes": codes})["rows"]

            assert [row["code"] for row in rows] == [f"{prefix}.1"]
            prices = {row["subcontractor"]: str(row["unit_price"]) for row in rows[0]["prices"]}
            assert prices == {None: "2.40", f"{prefix} Tiefbau": "1.90"}
            assert rows[0]["unit"] == "m" and rows[0]["kind"] == "activity"
