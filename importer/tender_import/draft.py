import re

from .store import jsonb


_UNIT_CODES = {
    "st": "ea", "st.": "ea", "stk": "ea", "stk.": "ea", "stck": "ea",
    "m2": "m²", "m²": "m²", "m3": "m³", "m³": "m³",
    "cm2": "cm²", "cm²": "cm²", "km2": "km²", "km²": "km²",
    "satz": "set", "set": "set", "psch": "lump_sum", "pau": "lump_sum",
    "std": "h", "std.": "h", "to": "t", "wo": "week", "mt": "month",
    "jahr": "year", "jahre": "year", "jr": "year", "mwo": "m·week", "stwo": "ea·week",
    "m2d": "m²·day", "m2wo": "m²·week", "md": "m·day",
}


def unit_code(raw):
    return _UNIT_CODES.get(raw.strip().casefold(), raw) if raw else None


def load_extractions(connection, document_id, kinds):
    document = connection.execute(
        """
        SELECT d.project_id, d.filename, d.format, d.exchange_phase, i.id, i.status, i.metadata
        FROM source_document d JOIN source_import i ON i.source_document_id = d.id
        WHERE d.id = %s ORDER BY i.imported_at DESC, i.id DESC LIMIT 1
        """, (document_id,),
    ).fetchone()
    if document is None or document[5] == "failed":
        raise ValueError("A successful source import is required")
    entries = connection.execute(
        """SELECT ordinal, kind, locator, payload FROM source_extract
           WHERE import_id = %s AND kind = ANY(%s) ORDER BY ordinal""",
        (document[4], kinds),
    ).fetchall()
    return document, entries


def create_draft(connection, document_id, package_code, title, boq_index, phase):
    with connection.transaction():
        document, entries = load_extractions(
            connection, document_id, ["boq_header", "section", "section_candidate", "item", "item_candidate"]
        )
        project_id, filename, document_format, exchange_phase, import_id, _, metadata = document
        if exchange_phase == "84" or document_format == "zip":
            raise ValueError("Select a scope document. GAEB bid submissions can be imported as reference prices.")
        indexes = {entry[3]["boq_index"] for entry in entries if entry[1] == "boq_header"}
        if boq_index is None and len(indexes) > 1:
            raise ValueError(f"Choose --boq-index from {sorted(indexes)}")
        if boq_index is not None and boq_index not in indexes:
            raise ValueError("This source does not contain that BoQ index")
        entries = [entry for entry in entries if boq_index is None or entry[3].get("boq_index") == boq_index]
        if not any(entry[1] in {"item", "item_candidate"} for entry in entries):
            raise ValueError("There are no extractable scope items in this document")

        connection.execute("SELECT lock_project(%s)", (project_id,))
        previous = connection.execute(
            """
            SELECT id, version_no FROM bom_version WHERE project_id = %s AND package_code = %s
            ORDER BY version_no DESC LIMIT 1
            """, (project_id, package_code),
        ).fetchone()
        # Retrying the same projection must not create extra versions.
        existing = connection.execute(
            """
            SELECT v.id, v.version_no FROM bom_version v JOIN bom_source s ON s.bom_version_id = v.id
            WHERE v.project_id = %s AND v.package_code = %s AND s.source_document_id = %s
            AND s.role = 'primary_scope' LIMIT 1
            """, (project_id, package_code, document_id),
        ).fetchone()
        if existing:
            return {"bom_version_id": str(existing[0]), "version": existing[1], "cached": True}

        boq_title = next((entry[3].get("boq_title") for entry in entries if entry[1] == "boq_header"), None)
        version_no = previous[1] + 1 if previous else 1
        version_id = connection.execute(
            """
            INSERT INTO bom_version (project_id, package_code, version_no, previous_version_id, title, phase)
            VALUES (%s, %s, %s, %s, %s, %s) RETURNING id
            """, (project_id, package_code, version_no, previous[0] if previous else None,
                  title or boq_title or metadata.get("title") or filename,
                  phase or {"83": "tender", "86": "award"}.get(exchange_phase)),
        ).fetchone()[0]
        connection.execute("INSERT INTO bom_source VALUES (%s, %s, 'primary_scope')", (version_id, document_id))
        sections = {}
        item_count = 0
        for ordinal, kind, locator, row in entries:
            parts = tuple(row.get("code_parts") or ())
            xml_path = locator.get("xml_path")
            if kind in {"section", "section_candidate"}:
                code = row.get("code") or ".".join(parts) or None
                parent = sections.get(row.get("parent_section")) or (sections.get(parts[:-1]) if len(parts) > 1 else None)
                if not parent and row.get("section_path"):
                    parent = sections.get(row["section_path"][-1])
                section_id = connection.execute(
                    """
                    INSERT INTO bom_section (bom_version_id, parent_section_id, display_code, title, sort_order)
                    VALUES (%s, %s, %s, %s, %s) RETURNING id
                    """, (version_id, parent, code, row.get("label") or code or "Untitled section", ordinal),
                ).fetchone()[0]
                for key in (xml_path, parts, code):
                    if key:
                        sections[key] = section_id
            elif kind in {"item", "item_candidate"}:
                section = row.get("section_path")
                parent = sections.get(section[-1]) if isinstance(section, list) and section else None
                if isinstance(section, str):
                    parent = sections.get(section)
                if parent is None and len(parts) > 1:
                    parent = sections.get(parts[:-1])
                flags = row.get("flags", {})
                pricing = "lump_sum" if flags.get("LumpSumItem") == "Yes" or flags.get("extra_type_flag") == "L" else "unit_rate"
                provisional = flags.get("Provis")
                if flags.get("unit_price_only") or flags.get("provisional_flag") == "E" or provisional == "WithoutTotal":
                    total_rule = "unit_price_only"
                elif provisional or flags.get("provisional_included") or flags.get("alternative_item") or flags.get("position_type") == "A":
                    total_rule = "conditional"
                else:
                    total_rule = "include"
                code = row.get("code")
                label = row.get("short_description") or row.get("long_description") or code or "Unresolved source item"
                connection.execute(
                    """
                    INSERT INTO bom_line
                        (bom_version_id, section_id, line_code, sort_order, short_description, long_description,
                         quantity, unit_code, raw_unit, pricing_basis, total_rule, source_document_id, source_locator)
                    VALUES (%s, %s, %s, %s, %s, %s, %s::numeric, %s, %s, %s, %s, %s, %s)
                    """, (version_id, parent, code, ordinal, label, row.get("long_description"),
                          row.get("quantity"), unit_code(row.get("unit")), row.get("unit"), pricing, total_rule, document_id,
                          jsonb({"import_id": str(import_id), "ordinal": ordinal, **locator})),
                )
                item_count += 1
    return {"bom_version_id": str(version_id), "version": version_no, "items": item_count, "status": "draft"}


def copy_prices(connection, document_id, currency):
    with connection.transaction():
        document, entries = load_extractions(connection, document_id, ["price", "item", "item_candidate"])
        project_id, _, _, _, import_id, _, metadata = document
        source_currency = (metadata.get("currency") or "").upper()
        currency = currency or {"EURO": "EUR", "€": "EUR"}.get(source_currency, source_currency)
        if not re.fullmatch(r"[A-Z]{3}", currency):
            raise ValueError("Currency could not be determined. Supply --currency, e.g. EUR.")
        connection.execute("SELECT lock_project(%s)", (project_id,))
        explicit_prices = [entry for entry in entries if entry[1] == "price"]
        priced = explicit_prices or entries
        item_by_code = {row[3].get("code_raw"): row[3] for row in entries if row[1] == "item" and row[3].get("code_raw")}
        inserted = 0
        for ordinal, _, locator, row in priced:
            if row.get("unit_price") is None and row.get("line_amount") is None:
                continue
            item = item_by_code.get(row.get("code_raw"), {})
            evidence = jsonb({"import_id": str(import_id), "ordinal": ordinal, **locator})
            inserted += connection.execute(
                """
                INSERT INTO reference_price
                    (source_document_id, source_line_code, source_locator, currency, quantity, unit_code,
                     unit_price, reported_line_amount)
                SELECT %s, %s, %s, %s, %s::numeric, %s, %s::numeric, %s::numeric
                WHERE NOT EXISTS (
                    SELECT FROM reference_price WHERE source_document_id = %s AND source_locator = %s
                )
                """, (document_id, row.get("code") or row.get("code_raw"), evidence, currency,
                      row.get("quantity") or item.get("quantity"), unit_code(row.get("unit") or item.get("unit")),
                      row.get("unit_price"), row.get("line_amount"), document_id, evidence),
            ).rowcount
    return {"document_id": str(document_id), "currency": currency, "reference_prices_added": inserted}
