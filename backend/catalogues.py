"""Read and manage the three BillBuild catalogues."""

from datetime import date
from decimal import Decimal
import re
from uuid import UUID

from psycopg import sql

PAGE_SIZE = 50
TABLES = {"products": "product", "suppliers": "supplier", "subcontractors": "subcontractor"}

PRODUCT_FIELDS = """
    p.id, p.name, p.supplier_sku AS sku, p.unit_code AS unit,
    p.review_status, p.archived_at, c.name AS category,
    s.id AS supplier_id, s.name AS supplier, s.archived_at AS supplier_archived_at,
    price.unit_price, price.currency, price.valid_from, price.price_basis
"""
PRODUCT_RELATIONS = """
    FROM product p JOIN product_category c ON c.id = p.category_id
    LEFT JOIN supplier s ON s.id = p.supplier_id
    LEFT JOIN LATERAL (
        SELECT unit_price, currency, valid_from, price_basis
        FROM product_price
        WHERE product_id = p.id AND valid_from <= CURRENT_DATE
        ORDER BY valid_from DESC, (price_basis = 'supplier_quote') DESC, (currency = 'EUR') DESC, currency
        LIMIT 1
    ) price ON true
"""
LISTS = {
    "products": f"SELECT {PRODUCT_FIELDS} {PRODUCT_RELATIONS}" + """
        WHERE ((p.archived_at IS NOT NULL) = %(archived)s)
          AND concat_ws(' ', p.name, p.supplier_sku, c.name, s.name) ILIKE %(pattern)s
          AND (%(supplier)s::uuid IS NULL OR p.supplier_id = %(supplier)s)
        ORDER BY lower(p.name), p.id
    """,
    "suppliers": """
        SELECT s.id, s.name, s.contact_name, s.email, s.phone, s.archived_at,
               (SELECT count(*) FROM product p WHERE p.supplier_id = s.id AND p.archived_at IS NULL) AS product_count
        FROM supplier s
        WHERE ((s.archived_at IS NOT NULL) = %(archived)s)
          AND concat_ws(' ', s.name, s.contact_name, s.email, s.phone) ILIKE %(pattern)s
        ORDER BY lower(s.name), s.id
    """,
    "subcontractors": """
        SELECT s.id, s.name, s.trade, s.contact_name, s.email, s.phone, s.archived_at
        FROM subcontractor s
        WHERE ((s.archived_at IS NOT NULL) = %(archived)s)
          AND concat_ws(' ', s.name, s.trade, s.contact_name, s.email, s.phone) ILIKE %(pattern)s
        ORDER BY lower(s.name), s.id
    """,
}


def identifier(value):
    try:
        return UUID(value)
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError("Select a valid catalogue record.") from error


def read(connection, kind, params):
    if kind == "products":
        if "id" in params:
            query = f"SELECT p.description, {PRODUCT_FIELDS} {PRODUCT_RELATIONS} WHERE p.id=%s"
            row = connection.execute(query, (identifier(params["id"]),)).fetchone()
            if not row:
                raise LookupError("This product was not found.")
            return row
        if params.get("options") == "1":
            return {
                "categories": connection.execute("SELECT name FROM product_category ORDER BY lower(name), name").fetchall(),
                "suppliers": connection.execute(
                    "SELECT id, name FROM supplier WHERE archived_at IS NULL ORDER BY lower(name), id",
                ).fetchall(),
            }
    query = params.get("q", "").strip()
    if len(query) > 200 or "\0" in query:
        raise ValueError("Enter a search of up to 200 characters.")
    page = int(params.get("page", "1"))
    if not 1 <= page <= 10000:
        raise ValueError("Select a valid page.")
    supplier = identifier(params["supplier"]) if "supplier" in params and kind == "products" else None
    pattern = "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    rows = connection.execute(
        LISTS[kind] + " LIMIT %(limit)s OFFSET %(offset)s",
        {"pattern": pattern, "supplier": supplier, "archived": params.get("view") == "archived",
         "limit": PAGE_SIZE + 1, "offset": (page - 1) * PAGE_SIZE},
    ).fetchall()
    return {"rows": rows[:PAGE_SIZE], "has_more": len(rows) > PAGE_SIZE}


def field(payload, name, maximum, required=False):
    value = payload.get(name)
    if value is None:
        value = ""
    if not isinstance(value, str) or len(value) > maximum or "\0" in value:
        raise ValueError(f"Enter a valid {name.replace('_', ' ')} of up to {maximum} characters.")
    value = value.strip()
    if required and not value:
        raise ValueError(f"Enter the {name.replace('_', ' ')}.")
    return value or None


def write_row(connection, kind, fields, record_id):
    table = sql.Identifier(TABLES[kind])
    columns = [sql.Identifier(column) for column in fields]
    if record_id:
        assignments = sql.SQL(", ").join(sql.SQL("{} = %s").format(col) for col in columns)
        query = sql.SQL("UPDATE {} SET {} WHERE id = %s AND archived_at IS NULL RETURNING id").format(table, assignments)
        row = connection.execute(query, (*fields.values(), record_id)).fetchone()
        if not row:
            raise LookupError("This catalogue record is unavailable for editing.")
        return row
    query = sql.SQL("INSERT INTO {} ({}) VALUES ({}) RETURNING id").format(
        table, sql.SQL(", ").join(columns), sql.SQL(", ").join([sql.Placeholder()] * len(columns)),
    )
    return connection.execute(query, tuple(fields.values())).fetchone()


def save_product(connection, payload, record_id):
    category = field(payload, "category", 160, required=True)
    supplier_id = identifier(payload["supplier_id"]) if payload.get("supplier_id") else None
    previous = None
    if record_id:
        previous = connection.execute(
            "SELECT supplier_id, unit_code, review_status FROM product WHERE id=%s AND archived_at IS NULL FOR UPDATE",
            (record_id,),
        ).fetchone()
        if not previous:
            raise LookupError("This product is unavailable for editing.")
    unit = field(payload, "unit", 64)
    if previous and previous["review_status"] == "approved" and (
        supplier_id != previous["supplier_id"] or unit != previous["unit_code"]
    ):
        raise ValueError("The supplier and unit of an approved product are fixed.")
    if supplier_id and (not previous or previous["supplier_id"] != supplier_id) and not connection.execute(
        "SELECT id FROM supplier WHERE id=%s AND archived_at IS NULL FOR SHARE", (supplier_id,),
    ).fetchone():
        raise ValueError("Select an active supplier.")
    connection.execute("INSERT INTO product_category (name) VALUES (%s) ON CONFLICT (name) DO NOTHING", (category,))
    category_id = connection.execute("SELECT id FROM product_category WHERE name=%s", (category,)).fetchone()["id"]
    fields = {
        "name": field(payload, "name", 300, required=True),
        "description": field(payload, "description", 250000, required=True),
        "supplier_sku": field(payload, "sku", 160),
        "unit_code": unit,
        "supplier_id": supplier_id,
        "category_id": category_id,
    }
    if not record_id:
        fields["review_status"] = "pending"
    result = write_row(connection, "products", fields, record_id)
    amount = field(payload, "unit_price", 24)
    if amount is not None:
        if not re.fullmatch(r"\d{1,14}(?:[.,]\d{1,6})?", amount):
            raise ValueError("Enter a nonnegative unit price with up to six decimal places.")
        currency = field(payload, "currency", 3, required=True).upper()
        if not re.fullmatch(r"[A-Z]{3}", currency):
            raise ValueError("Enter a three-letter currency code.")
        try:
            effective = date.fromisoformat(field(payload, "valid_from", 10, required=True))
        except ValueError as error:
            raise ValueError("Enter a valid price effective date.") from error
        connection.execute(
            """
            INSERT INTO product_price (product_id, unit_price, currency, valid_from)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (product_id, currency, price_basis, valid_from)
            DO UPDATE SET unit_price=excluded.unit_price
            """, (result["id"], Decimal(amount.replace(",", ".")), currency, effective),
        )
    return result


def write(connection, kind, payload):
    record_id = identifier(payload["id"]) if "id" in payload else None
    action = payload.get("action", "save")
    if action in ("archive", "restore"):
        if not record_id:
            raise ValueError("Select a valid catalogue record.")
        query = sql.SQL("UPDATE {} SET archived_at={} WHERE id=%s RETURNING id").format(
            sql.Identifier(TABLES[kind]), sql.SQL("now()" if action == "archive" else "NULL"),
        )
        row = connection.execute(query, (record_id,)).fetchone()
        if not row:
            raise LookupError("This catalogue record was not found.")
        return row
    if action != "save":
        raise ValueError("Select a valid catalogue action.")
    if kind == "products":
        return save_product(connection, payload, record_id)
    fields = {
        "name": field(payload, "name", 160, required=True),
        "contact_name": field(payload, "contact_name", 120),
        "email": field(payload, "email", 254),
        "phone": field(payload, "phone", 60),
    }
    if fields["email"] and not re.fullmatch(r"[^\s@]+@[^\s@]+", fields["email"]):
        raise ValueError("Enter a valid email address.")
    if kind == "subcontractors":
        fields["trade"] = field(payload, "trade", 120, required=True)
    return write_row(connection, kind, fields, record_id)
