"""Lists and company records shown in the BillBuild catalogues."""

import re
from uuid import UUID

from psycopg import sql

PAGE_SIZE = 50
COMPANIES = {"suppliers": "supplier", "subcontractors": "subcontractor"}
KINDS = {*COMPANIES, "products"}

LISTS = {
    "products": """
        SELECT p.id, p.name, p.supplier_sku AS sku, p.unit_code AS unit,
               c.name AS category, s.id AS supplier_id, s.name AS supplier
        FROM product p JOIN product_category c ON c.id = p.category_id
        LEFT JOIN supplier s ON s.id = p.supplier_id
        WHERE (concat_ws(' ', p.name, p.supplier_sku, c.name, s.name) ILIKE %(pattern)s)
          AND (%(supplier)s::uuid IS NULL OR p.supplier_id = %(supplier)s)
        ORDER BY lower(p.name), p.id
    """,
    "suppliers": """
        SELECT s.id, s.name, s.contact_name, s.email, s.phone,
               (SELECT count(*) FROM product p WHERE p.supplier_id = s.id) AS product_count
        FROM supplier s
        WHERE concat_ws(' ', s.name, s.contact_name, s.email, s.phone) ILIKE %(pattern)s
        ORDER BY lower(s.name), s.id
    """,
    "subcontractors": """
        SELECT s.id, s.name, s.trade, s.contact_name, s.email, s.phone
        FROM subcontractor s
        WHERE concat_ws(' ', s.name, s.trade, s.contact_name, s.email, s.phone) ILIKE %(pattern)s
        ORDER BY lower(s.name), s.id
    """,
}


def identifier(value):
    try:
        return UUID(value)
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError("Select a valid catalogue record.") from error


def listing(connection, kind, params):
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
        {"pattern": pattern, "supplier": supplier, "limit": PAGE_SIZE + 1, "offset": (page - 1) * PAGE_SIZE},
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


def save_company(connection, kind, payload):
    record_id = identifier(payload["id"]) if "id" in payload else None
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
    table = sql.Identifier(COMPANIES[kind])
    columns = [sql.Identifier(column) for column in fields]
    if record_id:
        assignments = sql.SQL(", ").join(sql.SQL("{} = %s").format(col) for col in columns)
        query = sql.SQL("UPDATE {} SET {} WHERE id = %s RETURNING id").format(table, assignments)
        row = connection.execute(query, (*fields.values(), record_id)).fetchone()
        if not row:
            raise LookupError("This catalogue record was not found.")
    else:
        query = sql.SQL("INSERT INTO {} ({}) VALUES ({}) RETURNING id").format(
            table, sql.SQL(", ").join(columns), sql.SQL(", ").join([sql.Placeholder()] * len(columns)),
        )
        row = connection.execute(query, tuple(fields.values())).fetchone()
    return row
