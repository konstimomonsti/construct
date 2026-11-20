-- Run on an initialized development database. All sample rows are rolled back.
BEGIN;

DO $$
DECLARE
    project_key uuid := gen_random_uuid();
    other_project uuid := gen_random_uuid();
    house uuid := gen_random_uuid();
    kitchen uuid := gen_random_uuid();
    hall uuid := gen_random_uuid();
    other_area uuid := gen_random_uuid();
    source_key uuid := gen_random_uuid();
    version_key uuid := gen_random_uuid();
    next_version uuid := gen_random_uuid();
    flooring uuid := gen_random_uuid();
    later_flooring uuid := gen_random_uuid();
    rate_only uuid := gen_random_uuid();
    kitchen_share uuid := gen_random_uuid();
    hall_share uuid := gen_random_uuid();
    estimate_key uuid := gen_random_uuid();
    kitchen_estimate uuid := gen_random_uuid();
    hall_estimate uuid := gen_random_uuid();
    material_key uuid := gen_random_uuid();
    activity_key uuid := gen_random_uuid();
    quote_key uuid := gen_random_uuid();
    issued_quote quote%ROWTYPE;
BEGIN
    INSERT INTO project (id, name) VALUES (project_key, 'Flooring smoke test'), (other_project, 'Separate project');
    INSERT INTO project_area (id, project_id, name, kind) VALUES (house, project_key, 'House', 'building');
    INSERT INTO project_area (id, project_id, name, kind) VALUES (other_area, other_project, 'Other house', 'building');
    INSERT INTO project_area (id, project_id, parent_area_id, name, kind) VALUES
        (kitchen, project_key, house, 'Kitchen', 'room'), (hall, project_key, house, 'Hall', 'room');
    BEGIN
        UPDATE project_area SET parent_area_id = kitchen WHERE id = house;
        RAISE EXCEPTION 'Accepted a cyclic area hierarchy';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    INSERT INTO source_document (id, project_id, filename, storage_key, sha256, format)
    VALUES (source_key, project_key, 'tender.X83', 'smoke/tender.X83', repeat('0', 64), 'gaeb_xml');
    INSERT INTO bom_version (id, project_id, package_code, version_no, title, phase, review_status)
    VALUES (version_key, project_key, 'FLOOR', 1, 'Floor finishes', 'tender', 'approved');
    INSERT INTO bom_version (id, project_id, package_code, version_no, title, previous_version_id)
    VALUES (next_version, project_key, 'FLOOR', 2, 'Floor finishes revised', version_key);
    INSERT INTO bom_source VALUES (version_key, source_key, 'primary_scope');
    INSERT INTO bom_line (id, bom_version_id, line_code, sort_order, short_description, quantity, unit_code, source_document_id)
    VALUES (flooring, version_key, '01.0001', 1, 'Supply and lay flooring', 18, 'm²', source_key);
    INSERT INTO bom_line (id, bom_version_id, sort_order, short_description, quantity, unit_code)
    VALUES (later_flooring, next_version, 1, 'Supply and lay flooring', 20, 'm²');
    INSERT INTO bom_line (id, bom_version_id, sort_order, short_description, total_rule)
    VALUES (rate_only, version_key, 2, 'Optional repairs, unit rate only', 'unit_price_only');
    INSERT INTO bom_line_distribution (id, bom_line_id, area_id, quantity) VALUES
        (kitchen_share, flooring, kitchen, 10), (hall_share, flooring, hall, 8);
    BEGIN
        INSERT INTO bom_line_distribution (bom_line_id, area_id, quantity) VALUES (flooring, other_area, 1);
        RAISE EXCEPTION 'Accepted a distribution to a different project';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO bom_line_distribution (bom_line_id, area_id, quantity) VALUES (flooring, house, 18);
        RAISE EXCEPTION 'Accepted overlapping parent and child shares';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE project_area SET parent_area_id = kitchen WHERE id = hall;
        RAISE EXCEPTION 'Accepted a move that overlaps existing shares';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    INSERT INTO material_item (id, bom_line_id, name, quantity, unit_code)
    VALUES (material_key, flooring, 'Flooring including waste', 19.8, 'm²');
    INSERT INTO activity_item (id, bom_line_id, name, quantity, unit_code)
    VALUES (activity_key, flooring, 'Lay flooring', 18, 'm²');
    INSERT INTO estimate (id, project_id, scenario_name, version_no, currency, status)
    VALUES (estimate_key, project_key, 'Base bid', 1, 'EUR', 'approved');
    INSERT INTO estimate_line (id, estimate_id, bom_line_id, bom_line_distribution_id, quantity, included_in_total)
    VALUES (kitchen_estimate, estimate_key, flooring, kitchen_share, 10, true);
    BEGIN
        INSERT INTO estimate_line (estimate_id, bom_line_id, quantity, included_in_total)
        VALUES (estimate_key, flooring, 18, true);
        RAISE EXCEPTION 'Accepted whole-line pricing alongside room pricing';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO estimate_line (estimate_id, bom_line_id, quantity, included_in_total)
        VALUES (estimate_key, later_flooring, 20, true);
        RAISE EXCEPTION 'Accepted two versions of the same package';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    INSERT INTO estimate_line (estimate_id, bom_line_id, included_in_total) VALUES (estimate_key, rate_only, false);
    INSERT INTO quote (id, estimate_id, quote_number, revision_no, customer_name, currency)
    VALUES (quote_key, estimate_key, 'Q-001', 1, 'Test customer', 'EUR');
    INSERT INTO quote_line (quote_id, bom_line_id, description, quantity, unit_code,
        sell_unit_price, net_amount, included_in_total, tax_rate, sort_order)
    VALUES (quote_key, flooring, 'Supply and lay flooring', 18, 'm²', 123.45, 2222.10, true, 0.19, 1),
        (quote_key, rate_only, 'Optional repairs', NULL, 'h', 70, NULL, false, 0.19, 2);
    BEGIN
        UPDATE quote SET status = 'issued' WHERE id = quote_key;
        RAISE EXCEPTION 'Issued a quote with unpriced room quantities';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    INSERT INTO estimate_line (id, estimate_id, bom_line_id, bom_line_distribution_id, quantity, included_in_total)
    VALUES (hall_estimate, estimate_key, flooring, hall_share, 8, true);
    INSERT INTO cost_component (estimate_id, estimate_line_id, material_item_id, category, description, resource_quantity, amount)
    VALUES (estimate_key, kitchen_estimate, material_key, 'materials', 'Flooring for the kitchen', 11, 550);
    INSERT INTO cost_component (estimate_id, estimate_line_id, activity_item_id, category, description, resource_quantity, amount)
    VALUES (estimate_key, hall_estimate, activity_key, 'labor', 'Installer hours in the hall', 6, 300);
    BEGIN
        INSERT INTO cost_component (estimate_id, estimate_line_id, material_item_id, activity_item_id, category, description, amount)
        VALUES (estimate_key, kitchen_estimate, material_key, activity_key, 'materials', 'Invalid dual link', 1);
        RAISE EXCEPTION 'Accepted a dual material and activity cost link';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    UPDATE quote SET status = 'issued' WHERE id = quote_key RETURNING * INTO STRICT issued_quote;
    IF (issued_quote.net_total, issued_quote.tax_total, issued_quote.gross_total) IS DISTINCT FROM (2222.10, 422.20, 2644.30) THEN
        RAISE EXCEPTION 'Unexpected quote totals: %, %, %', issued_quote.net_total, issued_quote.tax_total, issued_quote.gross_total;
    END IF;
    IF (SELECT status FROM estimate WHERE id = estimate_key) IS DISTINCT FROM 'locked' THEN
        RAISE EXCEPTION 'Issuing a quote did not lock its estimate';
    END IF;
    BEGIN
        UPDATE bom_line SET quantity = 19 WHERE id = flooring;
        RAISE EXCEPTION 'Accepted a mutation to a locked BOM version';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE cost_component SET amount = 999 WHERE estimate_line_id = kitchen_estimate;
        RAISE EXCEPTION 'Accepted a change to the costs behind an issued quote';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE quote_line SET sell_unit_price = 1 WHERE quote_id = quote_key;
        RAISE EXCEPTION 'Accepted a mutation to an issued quote line';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    RAISE NOTICE 'Smoke test passed: room costs consolidate to one tender line, optional rates are excluded, and issued versions are locked';
END;
$$;

DO $$
DECLARE
    supplier_key uuid;
    category_key uuid;
    product_key uuid;
    project_key uuid;
    version_key uuid;
    line_key uuid;
    material_key uuid;
    first_date date := DATE '2025-01-01';
    second_date date := DATE '2025-02-01';
    supplier_label text := 'Catalogue test supplier ' || gen_random_uuid();
    category_label text := 'Pipes ' || gen_random_uuid();
BEGIN
    INSERT INTO supplier (name) VALUES (supplier_label) RETURNING id INTO supplier_key;
    INSERT INTO product_category (name) VALUES (category_label) RETURNING id INTO category_key;
    INSERT INTO product (supplier_id, category_id, name, description, unit_code)
    VALUES (supplier_key, category_key, '20 × 3 cm steel pipe', 'Steel pipe test specification', 'm')
    RETURNING id INTO product_key;
    INSERT INTO product_price (product_id, valid_from, currency, unit_price)
    VALUES (product_key, first_date, 'EUR', 12.50), (product_key, second_date, 'EUR', 13.75);
    SET CONSTRAINTS product_requires_price IMMEDIATE;

    IF (SELECT unit_price FROM product_price
        WHERE product_id = product_key AND currency = 'EUR' AND valid_from < second_date
        ORDER BY valid_from DESC LIMIT 1) IS DISTINCT FROM 12.50 THEN
        RAISE EXCEPTION 'Catalogue did not preserve the historical price';
    END IF;
    IF (SELECT unit_price FROM product_price
        WHERE product_id = product_key AND currency = 'EUR' AND valid_from <= second_date
        ORDER BY valid_from DESC LIMIT 1) IS DISTINCT FROM 13.75 THEN
        RAISE EXCEPTION 'Catalogue did not select the new price on its effective date';
    END IF;
    BEGIN
        INSERT INTO product (supplier_id, category_id, name, description, unit_code)
        VALUES (supplier_key, category_key, 'Missing price', 'Invalid product with no price', 'm');
        RAISE EXCEPTION 'Accepted a product with no dated price';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO product_price (product_id, valid_from, currency, unit_price)
        VALUES (product_key, first_date, 'EUR', 12.75);
        RAISE EXCEPTION 'Accepted duplicate dated product prices';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
        DELETE FROM product_price WHERE product_id = product_key;
        SET CONSTRAINTS product_retains_price IMMEDIATE;
        RAISE EXCEPTION 'Accepted removal of all prices for a catalogue product';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    INSERT INTO project (name) VALUES ('Catalogue smoke test') RETURNING id INTO project_key;
    INSERT INTO bom_version (project_id, package_code, version_no, title)
    VALUES (project_key, 'PIPE', 1, 'Pipework') RETURNING id INTO version_key;
    INSERT INTO bom_line (bom_version_id, sort_order, short_description)
    VALUES (version_key, 1, 'Supply pipe to site') RETURNING id INTO line_key;
    INSERT INTO material_item (bom_line_id, product_id, name, quantity, unit_code)
    VALUES (line_key, product_key, 'Steel pipe as specified in tender', 30, 'm') RETURNING id INTO material_key;
    IF NOT EXISTS (
        SELECT FROM material_item m JOIN product p ON m.product_id = p.id
        WHERE m.id = material_key AND p.supplier_id = supplier_key AND p.category_id = category_key
        AND m.name = 'Steel pipe as specified in tender'
    ) THEN
        RAISE EXCEPTION 'Catalogue product did not link back to its BOM material';
    END IF;

    RAISE NOTICE 'Catalogue smoke test passed: dated rates, supplier/category links, and BOM material selection';
END;
$$;

ROLLBACK;
