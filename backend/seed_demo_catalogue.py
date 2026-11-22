"""Seed a demo catalogue so every position of a tender PDF finds a priced product.

Usage (PYTHONPATH `backend;backend/importer`, `DATABASE_URL` set):

    python backend/seed_demo_catalogue.py <tender.pdf> [--dry-run]

One product per distinct (name, unit) is created for the demo supplier. The script is idempotent: products are
looked up by (supplier_id, supplier_sku) and updated in place, so a rerun changes nothing.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
import hashlib
import os
from pathlib import Path
import sys
from typing import Any

SUPPLIER_NAME = "Demo-Lieferant Rohbau"
SKU_PREFIX = "DEMO-"
CURRENCY = "EUR"
FALLBACK_CATEGORY = "Sonstiges"
CENT = Decimal("0.01")

# Fallback price range (EUR per unit) by canonical unit (see analysis.units.normalize).
UNIT_RANGES: dict[str, tuple[int, int]] = {
    "lump_sum": (500, 25000),
    "m²": (8, 90),
    "m³": (25, 280),
    "m": (6, 120),
    "ea": (15, 900),
    "t": (900, 1800),
    "kg": (1, 3),
    "h": (38, 75),
    "set": (60, 1500),
    "l": (1, 12),
}
DEFAULT_RANGE = (10, 200)

# Keyword -> {canonical unit: (low, high)}. The first keyword found in the casefolded name wins, if it has the unit.
KEYWORD_RANGES: tuple[tuple[tuple[str, ...], dict[str, tuple[int, int]]], ...] = (
    (("bewehrung", "betonstahl", "stahlmatte"), {"t": (1100, 1800), "kg": (1, 3), "m²": (6, 18)}),
    (("schalung",), {"m²": (18, 90), "m": (6, 40), "lump_sum": (2500, 25000)}),
    (("beton",), {"m³": (95, 280), "m²": (12, 90), "m": (15, 120), "ea": (80, 900)}),
    (("erdaushub", "aushub", "boden"), {"m³": (25, 70), "m²": (8, 30), "t": (900, 1100)}),
    (("rohr", "kanal", "leitung"), {"m": (14, 120), "ea": (15, 400)}),
    (("container",), {"ea": (120, 600), "lump_sum": (500, 4000), "h": (45, 75)}),
    (("gerüst", "geruest"), {"m²": (8, 22), "lump_sum": (3000, 25000)}),
)


@dataclass(frozen=True)
class ProductSpec:
    """One catalogue product derived from the tender positions that share (name, unit)."""

    sku: str
    name: str
    description: str
    unit: str
    category: str
    price: Decimal
    oz: str


@dataclass
class SeedPlan:
    specs: list[ProductSpec] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)  # (oz, reason)
    positions: int = 0
    shared_text_conflicts: int = 0  # positions sharing a product but carrying a different long text


# ---------------------------------------------------------------------------------------------------------------
# Pure helpers (no database)
# ---------------------------------------------------------------------------------------------------------------

def canonical_unit(unit: str) -> str:
    """Canonical unit code, as the matcher compares units via `tender_unit`."""
    from workspace_product_match import tender_unit

    return tender_unit(unit) or ""


def dedupe_key(name: str, unit: str) -> tuple[tuple[str, ...], str]:
    """Key the matcher cannot tell apart: indexed name tokens plus canonical unit."""
    from workspace_product_match import tokens

    return tokens(name), canonical_unit(unit)


def product_description(short: str, long: str) -> str:
    """The long text without its first line when that equals the short text; never empty."""
    short, long = (short or "").strip(), (long or "").strip()
    # Keep the printed long text as it is: the matcher compares position and product text, and a title that
    # the PDF repeats in the description must be repeated here too, or the lump sums stay unmatched.
    return long or short


def sku_for(oz: str) -> str:
    return SKU_PREFIX + oz.strip().rstrip(".")


def _hash_fractions(oz: str) -> tuple[Decimal, Decimal]:
    """Two stable fractions in [0, 1) derived from the OZ."""
    digest = hashlib.sha256(oz.encode("utf-8")).digest()
    return (Decimal(int.from_bytes(digest[0:4], "big")) / Decimal(2**32),
            Decimal(int.from_bytes(digest[4:8], "big")) / Decimal(2**32))


def price_range(name: str, unit: str) -> tuple[int, int]:
    """Base price range for the trade (by keyword) and the unit."""
    canon = canonical_unit(unit)
    lowered = name.casefold()
    for keywords, by_unit in KEYWORD_RANGES:
        if canon in by_unit and any(word in lowered for word in keywords):
            return by_unit[canon]
    return UNIT_RANGES.get(canon, DEFAULT_RANGE)


def demo_price(name: str, unit: str, oz: str) -> Decimal:
    """Deterministic unit price in EUR: a point in the trade range plus a stable +/-12 % variation.

    The result lies in [0.88 * low, 1.12 * high] of `price_range` and has two decimals.
    """
    low, high = price_range(name, unit)
    position, variation = _hash_fractions(oz)
    base = Decimal(low) + Decimal(high - low) * position
    price = base * (Decimal("0.88") + Decimal("0.24") * variation)
    return price.quantize(CENT, rounding=ROUND_HALF_UP)


def build_plan(positions: list[dict[str, Any]]) -> SeedPlan:
    """Dedupe positions by (name, unit) and derive one product spec per group."""
    plan = SeedPlan(positions=len(positions))
    seen: dict[tuple[Any, ...], ProductSpec] = {}
    used_skus: set[str] = set()
    for position in positions:
        oz = str(position.get("oz") or "").strip()
        short = str(position.get("short") or "").strip()
        unit = str(position.get("unit") or "").strip()
        label = oz or "(ohne OZ)"
        if not short or short == "(ohne Kurztext)":
            plan.skipped.append((label, "no short text"))
            continue
        if not unit:
            plan.skipped.append((label, "no unit"))
            continue
        if not oz:
            plan.skipped.append((label, "no OZ for the SKU"))
            continue
        key = dedupe_key(short, unit)
        if not key[0]:
            plan.skipped.append((label, "short text has no indexable tokens"))
            continue
        description = product_description(short, str(position.get("long") or ""))
        key = (*key, dedupe_key(description, unit)[0])  # same title, other text: its own product
        existing = seen.get(key)
        if existing is not None:
            if description != existing.description:
                plan.shared_text_conflicts += 1
            continue
        sku = sku_for(oz)
        suffix = 2
        while sku in used_skus:  # the same OZ in two sheets
            sku, suffix = f"{sku_for(oz)}-{suffix}", suffix + 1
        used_skus.add(sku)
        path = position.get("path") or []
        category = str(path[0].get("label") or "").strip() if path else ""
        spec = ProductSpec(sku=sku, name=short, description=description, unit=unit,
                           category=category or FALLBACK_CATEGORY,
                           price=demo_price(short, unit, oz), oz=oz)
        seen[key] = spec
        plan.specs.append(spec)
    return plan


# ---------------------------------------------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------------------------------------------

@dataclass
class SeedResult:
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    skipped: list[tuple[str, str]] = field(default_factory=list)


def _get_or_create(connection: Any, table: str, name: str) -> Any:
    """Get or create a row of `supplier` / `product_category` by its UNIQUE name."""
    row = connection.execute(f"SELECT id FROM {table} WHERE name = %s", (name,)).fetchone()
    if row:
        return row["id"]
    return connection.execute(f"INSERT INTO {table} (name) VALUES (%s) RETURNING id", (name,)).fetchone()["id"]


def apply_plan(connection: Any, plan: SeedPlan, today: date) -> SeedResult:
    """Insert or update the planned products inside the caller's transaction."""
    result = SeedResult()
    supplier_id = _get_or_create(connection, "supplier", SUPPLIER_NAME)
    categories: dict[str, Any] = {}
    for spec in plan.specs:
        category_id = categories.get(spec.category)
        if category_id is None:
            category_id = categories[spec.category] = _get_or_create(connection, "product_category", spec.category)
        row = connection.execute(
            "SELECT id, name, description, unit_code, category_id, archived_at FROM product "
            "WHERE supplier_id = %s AND supplier_sku = %s", (supplier_id, spec.sku)).fetchone()
        if row is None:
            product_id = connection.execute(
                "INSERT INTO product (supplier_id, category_id, supplier_sku, name, description, unit_code) "
                "VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
                (supplier_id, category_id, spec.sku, spec.name, spec.description, spec.unit)).fetchone()["id"]
            connection.execute(
                "INSERT INTO product_price (product_id, valid_from, currency, unit_price) VALUES (%s, %s, %s, %s)",
                (product_id, today, CURRENCY, spec.price))
            result.created += 1
            continue
        if row["unit_code"] != spec.unit:  # unit_code is immutable (protect_approved_product trigger)
            result.skipped.append((spec.oz, f"{spec.sku} exists with unit {row['unit_code']!r}, not {spec.unit!r}"))
            continue
        changed = False
        if (row["name"], row["description"], row["category_id"]) != (spec.name, spec.description, category_id) \
                or row["archived_at"] is not None:
            connection.execute(
                "UPDATE product SET name = %s, description = %s, category_id = %s, archived_at = NULL WHERE id = %s",
                (spec.name, spec.description, category_id, row["id"]))
            changed = True
        latest = connection.execute(
            "SELECT id, valid_from, unit_price FROM product_price WHERE product_id = %s AND currency = %s "
            "ORDER BY valid_from DESC LIMIT 1", (row["id"], CURRENCY)).fetchone()
        if latest is None or Decimal(latest["unit_price"]) != spec.price:
            if latest is not None and latest["valid_from"] == today:
                connection.execute("UPDATE product_price SET unit_price = %s WHERE id = %s",
                                   (spec.price, latest["id"]))
            else:
                connection.execute(
                    "INSERT INTO product_price (product_id, valid_from, currency, unit_price) "
                    "VALUES (%s, %s, %s, %s)", (row["id"], today, CURRENCY, spec.price))
            changed = True
        if changed:
            result.updated += 1
        else:
            result.unchanged += 1
    return result


def print_summary(plan: SeedPlan, result: SeedResult | None, dry_run: bool) -> None:
    print(f"Positions read: {plan.positions}")
    print(f"Distinct products planned: {len(plan.specs)}")
    if plan.shared_text_conflicts:
        print(f"Positions sharing a product with a different long text (they may not match): "
              f"{plan.shared_text_conflicts}")
    if result:
        print(f"Products created: {result.created}, updated: {result.updated}, unchanged: {result.unchanged}"
              + (" (dry run, rolled back)" if dry_run else ""))
    skipped = [*plan.skipped, *(result.skipped if result else [])]
    print(f"Products skipped: {len(skipped)}")
    for oz, reason in skipped:
        print(f"  - {oz}: {reason}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Seed a demo catalogue from the positions of a tender PDF.")
    parser.add_argument("tender", type=Path, help="tender file (PDF, or anything workspace_parse reads)")
    parser.add_argument("--dry-run", action="store_true", help="do everything, then roll back")
    args = parser.parse_args(argv)

    dsn = os.environ.get("DATABASE_URL", "")
    if not dsn:
        print("DATABASE_URL is not set", file=sys.stderr)
        return 2

    import workspace_parse
    positions = workspace_parse.preview(args.tender.name, args.tender.read_bytes())["positions"]
    plan = build_plan(positions)

    import psycopg
    from psycopg.rows import dict_row
    with psycopg.connect(dsn, row_factory=dict_row) as connection:  # one transaction, committed on clean exit
        result = apply_plan(connection, plan, date.today())
        if args.dry_run:
            connection.rollback()
    print_summary(plan, result, args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
