-- Serialize cross-row validation within each project. Separate projects can write independently.
CREATE FUNCTION lock_project(project_key uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM id FROM project WHERE id = project_key FOR NO KEY UPDATE;
END;
$$;

CREATE FUNCTION protect_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    column_name text;
BEGIN
    FOREACH column_name IN ARRAY TG_ARGV LOOP
        IF to_jsonb(NEW) -> column_name IS DISTINCT FROM to_jsonb(OLD) -> column_name THEN
            RAISE EXCEPTION '% cannot change on an existing % row', column_name, TG_TABLE_NAME
                USING ERRCODE = '23514';
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$;

CREATE TRIGGER a_area_owner BEFORE UPDATE ON project_area
FOR EACH ROW EXECUTE FUNCTION protect_ownership('id', 'project_id');
CREATE TRIGGER a_source_owner BEFORE UPDATE ON source_document
FOR EACH ROW EXECUTE FUNCTION protect_ownership('id', 'project_id', 'storage_key', 'sha256');
CREATE TRIGGER a_bom_version_owner BEFORE UPDATE ON bom_version
FOR EACH ROW EXECUTE FUNCTION protect_ownership('id', 'project_id', 'package_code', 'version_no');
CREATE TRIGGER a_bom_source_owner BEFORE UPDATE ON bom_source
FOR EACH ROW EXECUTE FUNCTION protect_ownership('bom_version_id', 'source_document_id');
CREATE TRIGGER a_section_owner BEFORE UPDATE ON bom_section
FOR EACH ROW EXECUTE FUNCTION protect_ownership('id', 'bom_version_id');
CREATE TRIGGER a_bom_line_owner BEFORE UPDATE ON bom_line
FOR EACH ROW EXECUTE FUNCTION protect_ownership('id', 'bom_version_id');
CREATE TRIGGER a_distribution_owner BEFORE UPDATE ON bom_line_distribution
FOR EACH ROW EXECUTE FUNCTION protect_ownership('id', 'bom_line_id');
CREATE TRIGGER a_material_group_owner BEFORE UPDATE ON material_group
FOR EACH ROW EXECUTE FUNCTION protect_ownership('id', 'project_id');
CREATE TRIGGER a_activity_group_owner BEFORE UPDATE ON activity_group
FOR EACH ROW EXECUTE FUNCTION protect_ownership('id', 'project_id');
CREATE TRIGGER a_material_item_owner BEFORE UPDATE ON material_item
FOR EACH ROW EXECUTE FUNCTION protect_ownership('id', 'bom_line_id');
CREATE TRIGGER a_activity_item_owner BEFORE UPDATE ON activity_item
FOR EACH ROW EXECUTE FUNCTION protect_ownership('id', 'bom_line_id');
CREATE TRIGGER a_risk_owner BEFORE UPDATE ON risk_finding
FOR EACH ROW EXECUTE FUNCTION protect_ownership('id', 'project_id');
CREATE TRIGGER a_estimate_owner BEFORE UPDATE ON estimate
FOR EACH ROW EXECUTE FUNCTION protect_ownership('id', 'project_id');
CREATE TRIGGER a_estimate_line_owner BEFORE UPDATE ON estimate_line
FOR EACH ROW EXECUTE FUNCTION protect_ownership('id', 'estimate_id', 'bom_line_id');
CREATE TRIGGER a_cost_owner BEFORE UPDATE ON cost_component
FOR EACH ROW EXECUTE FUNCTION protect_ownership('id', 'estimate_id');
CREATE TRIGGER a_quote_owner BEFORE UPDATE ON quote
FOR EACH ROW EXECUTE FUNCTION protect_ownership('id', 'estimate_id');
CREATE TRIGGER a_quote_line_owner BEFORE UPDATE ON quote_line
FOR EACH ROW EXECUTE FUNCTION protect_ownership('id', 'quote_id');

-- Both hierarchies pair this cycle check with a same-owner composite foreign key.
CREATE FUNCTION check_hierarchy_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    parent_column text := TG_ARGV[0];
    parent_key uuid := (to_jsonb(NEW) ->> parent_column)::uuid;
    is_cycle boolean;
BEGIN
    IF TG_TABLE_NAME = 'project_area' THEN
        PERFORM lock_project(NEW.project_id);
    ELSE
        PERFORM lock_project(project_id) FROM bom_version WHERE id = NEW.bom_version_id;
    END IF;

    IF parent_key IS NOT NULL THEN
        EXECUTE format(
        'WITH RECURSIVE ancestors(id) AS (
            SELECT $1
            UNION
            SELECT node.%1$I FROM %2$I node JOIN ancestors ON node.id = ancestors.id
            WHERE node.%1$I IS NOT NULL
         ) SELECT EXISTS (SELECT FROM ancestors WHERE id = $2)',
        parent_column, TG_TABLE_NAME
        ) INTO is_cycle USING parent_key, NEW.id;
        IF is_cycle THEN
            RAISE EXCEPTION '% hierarchy cannot contain a cycle', TG_TABLE_NAME USING ERRCODE = '23514';
        END IF;
    END IF;
    IF TG_TABLE_NAME = 'project_area' AND TG_OP = 'UPDATE' THEN
        IF EXISTS (
            WITH RECURSIVE descendants(id) AS (
                SELECT NEW.id
                UNION
                SELECT area.id FROM project_area area JOIN descendants d ON area.parent_area_id = d.id
            ),
            ancestors(id) AS (
                SELECT parent_key
                UNION
                SELECT area.parent_area_id FROM project_area area JOIN ancestors a ON area.id = a.id
            )
            SELECT FROM bom_line_distribution upper_share
            JOIN bom_line_distribution lower_share ON lower_share.bom_line_id = upper_share.bom_line_id
            WHERE upper_share.area_id IN (SELECT id FROM ancestors)
            AND lower_share.area_id IN (SELECT id FROM descendants)
        ) THEN
            RAISE EXCEPTION 'Moving this area would make BOM line distributions overlap' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER hierarchy_cycle AFTER INSERT OR UPDATE OF parent_area_id ON project_area
FOR EACH ROW EXECUTE FUNCTION check_hierarchy_cycle('parent_area_id');
CREATE TRIGGER hierarchy_cycle AFTER INSERT OR UPDATE OF parent_section_id ON bom_section
FOR EACH ROW EXECUTE FUNCTION check_hierarchy_cycle('parent_section_id');

CREATE FUNCTION guard_bom_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    record_data jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
    version_key uuid;
    project_key uuid;
BEGIN
    IF TG_TABLE_NAME = 'bom_version' THEN
        version_key := (record_data ->> 'id')::uuid;
        project_key := (record_data ->> 'project_id')::uuid;
    ELSE
        IF record_data ? 'bom_version_id' THEN
            version_key := (record_data ->> 'bom_version_id')::uuid;
        ELSE
            SELECT bom_version_id INTO version_key
            FROM bom_line WHERE id = (record_data ->> 'bom_line_id')::uuid;
        END IF;
        SELECT project_id INTO project_key FROM bom_version WHERE id = version_key;
    END IF;

    PERFORM lock_project(project_key);
    IF EXISTS (
        SELECT FROM estimate e
        JOIN estimate_line el ON el.estimate_id = e.id
        JOIN bom_line bl ON bl.id = el.bom_line_id
        WHERE bl.bom_version_id = version_key AND e.status = 'locked'
    ) THEN
        RAISE EXCEPTION 'BOM version % is locked by an issued quote', version_key USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;

    IF TG_TABLE_NAME = 'bom_version' THEN
        IF EXISTS (
            SELECT FROM bom_version
            WHERE id = NEW.previous_version_id AND version_no >= NEW.version_no
        ) THEN
            RAISE EXCEPTION 'A BOM predecessor must have an earlier version number' USING ERRCODE = '23514';
        END IF;
    ELSIF TG_TABLE_NAME = 'bom_line' THEN
        IF EXISTS (
            SELECT FROM bom_line WHERE id = NEW.alternative_for_line_id AND alternative_for_line_id IS NOT NULL
        ) OR (NEW.alternative_for_line_id IS NOT NULL AND EXISTS (
            SELECT FROM bom_line WHERE alternative_for_line_id = NEW.id
        )) THEN
            RAISE EXCEPTION 'A BOM alternative must reference a base line' USING ERRCODE = '23514';
        END IF;
    ELSIF TG_TABLE_NAME = 'bom_line_distribution' THEN
        IF NOT EXISTS (
            SELECT FROM project_area WHERE id = NEW.area_id AND project_id = project_key
        ) THEN
            RAISE EXCEPTION 'A distribution area must belong to its BOM project' USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
            WITH RECURSIVE ancestors(area_id) AS (
                SELECT parent_area_id FROM project_area WHERE id = NEW.area_id
                UNION
                SELECT pa.parent_area_id FROM project_area pa JOIN ancestors a ON pa.id = a.area_id
            ),
            descendants(area_id) AS (
                SELECT id FROM project_area WHERE parent_area_id = NEW.area_id
                UNION
                SELECT pa.id FROM project_area pa JOIN descendants d ON pa.parent_area_id = d.area_id
            )
            SELECT FROM bom_line_distribution d WHERE d.bom_line_id = NEW.bom_line_id AND d.id <> NEW.id
            AND d.area_id IN (SELECT area_id FROM ancestors UNION SELECT area_id FROM descendants)
        ) THEN
            RAISE EXCEPTION 'A BOM line cannot be distributed to overlapping areas' USING ERRCODE = '23514';
        END IF;
    ELSIF TG_TABLE_NAME = 'material_item' THEN
        IF NEW.material_group_id IS NOT NULL AND NOT EXISTS (
            SELECT FROM material_group WHERE id = NEW.material_group_id AND project_id = project_key
        ) THEN
            RAISE EXCEPTION 'A material group must belong to its BOM project' USING ERRCODE = '23514';
        END IF;
    ELSIF TG_TABLE_NAME = 'activity_item' THEN
        IF NEW.activity_group_id IS NOT NULL AND NOT EXISTS (
            SELECT FROM activity_group WHERE id = NEW.activity_group_id AND project_id = project_key
        ) THEN
            RAISE EXCEPTION 'An activity group must belong to its BOM project' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_bom_scope BEFORE INSERT OR UPDATE OR DELETE ON bom_version
FOR EACH ROW EXECUTE FUNCTION guard_bom_scope();
CREATE TRIGGER guard_bom_scope BEFORE INSERT OR UPDATE OR DELETE ON bom_section
FOR EACH ROW EXECUTE FUNCTION guard_bom_scope();
CREATE TRIGGER guard_bom_scope BEFORE INSERT OR UPDATE OR DELETE ON bom_line
FOR EACH ROW EXECUTE FUNCTION guard_bom_scope();
CREATE TRIGGER guard_bom_scope BEFORE INSERT OR UPDATE OR DELETE ON bom_line_distribution
FOR EACH ROW EXECUTE FUNCTION guard_bom_scope();
CREATE TRIGGER guard_bom_scope BEFORE INSERT OR UPDATE OR DELETE ON material_item
FOR EACH ROW EXECUTE FUNCTION guard_bom_scope();
CREATE TRIGGER guard_bom_scope BEFORE INSERT OR UPDATE OR DELETE ON activity_item
FOR EACH ROW EXECUTE FUNCTION guard_bom_scope();

CREATE FUNCTION check_bom_source_project() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT FROM bom_version v JOIN source_document d ON d.project_id = v.project_id
        WHERE v.id = NEW.bom_version_id AND d.id = NEW.source_document_id
    ) THEN
        RAISE EXCEPTION 'A BOM and its source must belong to the same project' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER check_bom_source_project BEFORE INSERT OR UPDATE ON bom_source
FOR EACH ROW EXECUTE FUNCTION check_bom_source_project();

CREATE FUNCTION check_risk_project() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.bom_line_id IS NOT NULL AND NOT EXISTS (
        SELECT FROM bom_line bl JOIN bom_version v ON v.id = bl.bom_version_id
        WHERE bl.id = NEW.bom_line_id AND v.project_id = NEW.project_id
    ) THEN
        RAISE EXCEPTION 'A risk and its BOM line must belong to the same project' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER check_risk_project BEFORE INSERT OR UPDATE ON risk_finding
FOR EACH ROW EXECUTE FUNCTION check_risk_project();

CREATE FUNCTION guard_estimate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM lock_project(CASE WHEN TG_OP = 'DELETE' THEN OLD.project_id ELSE NEW.project_id END);
    IF TG_OP <> 'INSERT' AND OLD.status = 'locked' THEN
        RAISE EXCEPTION 'A locked estimate is immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_estimate BEFORE INSERT OR UPDATE OR DELETE ON estimate
FOR EACH ROW EXECUTE FUNCTION guard_estimate();

CREATE FUNCTION guard_estimate_detail() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    estimate_key uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.estimate_id ELSE NEW.estimate_id END;
    project_key uuid;
    estimate_status text;
    bill_version bom_version%ROWTYPE;
    estimate_bom_line uuid;
BEGIN
    SELECT project_id INTO project_key FROM estimate WHERE id = estimate_key;
    PERFORM lock_project(project_key);
    SELECT status INTO estimate_status FROM estimate WHERE id = estimate_key;
    IF estimate_status = 'locked' THEN
        RAISE EXCEPTION 'A locked estimate is immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;

    IF TG_TABLE_NAME = 'estimate_line' THEN
        SELECT v.* INTO bill_version FROM bom_line bl
        JOIN bom_version v ON v.id = bl.bom_version_id WHERE bl.id = NEW.bom_line_id;
        IF bill_version.project_id IS DISTINCT FROM project_key THEN
            RAISE EXCEPTION 'An estimate and its BOM line must belong to the same project' USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
            SELECT FROM estimate_line el JOIN bom_line bl ON bl.id = el.bom_line_id
            JOIN bom_version v ON v.id = bl.bom_version_id
            WHERE el.estimate_id = estimate_key AND el.id <> NEW.id
            AND v.package_code = bill_version.package_code AND v.id <> bill_version.id
        ) THEN
            RAISE EXCEPTION 'Use one BOM version per package in an estimate' USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
            SELECT FROM estimate_line el WHERE el.estimate_id = estimate_key
            AND el.bom_line_id = NEW.bom_line_id AND el.id <> NEW.id
            AND (el.bom_line_distribution_id IS NULL) <> (NEW.bom_line_distribution_id IS NULL)
        ) THEN
            RAISE EXCEPTION 'Use whole-line or room pricing for a BOM line, never both' USING ERRCODE = '23514';
        END IF;
    ELSE
        SELECT bom_line_id INTO estimate_bom_line FROM estimate_line
        WHERE id = NEW.estimate_line_id AND estimate_id = estimate_key;

        IF NEW.material_item_id IS NOT NULL AND NOT EXISTS (
            SELECT FROM material_item WHERE id = NEW.material_item_id AND bom_line_id = estimate_bom_line
        ) THEN
            RAISE EXCEPTION 'Material costs must reference an item from the estimate line’s BOM line' USING ERRCODE = '23514';
        END IF;
        IF NEW.activity_item_id IS NOT NULL AND NOT EXISTS (
            SELECT FROM activity_item WHERE id = NEW.activity_item_id AND bom_line_id = estimate_bom_line
        ) THEN
            RAISE EXCEPTION 'Activity costs must reference an item from the estimate line’s BOM line' USING ERRCODE = '23514';
        END IF;
        IF NEW.risk_finding_id IS NOT NULL AND NOT EXISTS (
            SELECT FROM risk_finding WHERE id = NEW.risk_finding_id AND project_id = project_key
        ) THEN
            RAISE EXCEPTION 'A cost and its risk must belong to the same project' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_estimate_detail BEFORE INSERT OR UPDATE OR DELETE ON estimate_line
FOR EACH ROW EXECUTE FUNCTION guard_estimate_detail();
CREATE TRIGGER guard_estimate_detail BEFORE INSERT OR UPDATE OR DELETE ON cost_component
FOR EACH ROW EXECUTE FUNCTION guard_estimate_detail();

CREATE FUNCTION validate_estimate_for_quote(estimate_key uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT FROM estimate_line el JOIN bom_line bl ON bl.id = el.bom_line_id
        WHERE el.estimate_id = estimate_key AND el.included_in_total AND bl.total_rule = 'unit_price_only'
    ) THEN
        RAISE EXCEPTION 'A unit-price-only BOM line cannot contribute to the estimate total' USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT FROM estimate_line WHERE estimate_id = estimate_key
        GROUP BY bom_line_id HAVING bool_or(included_in_total) <> bool_and(included_in_total)
    ) THEN
        RAISE EXCEPTION 'All estimate rows for a BOM line must use the same inclusion decision' USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT FROM estimate_line el JOIN bom_line bl ON bl.id = el.bom_line_id
        WHERE el.estimate_id = estimate_key AND el.included_in_total
        GROUP BY COALESCE(bl.alternative_for_line_id, bl.id)
        HAVING count(DISTINCT bl.id) > 1
    ) THEN
        RAISE EXCEPTION 'Include only one base or alternative in each set' USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT FROM estimate_line el
        JOIN bom_line bl ON bl.id = el.bom_line_id
        CROSS JOIN LATERAL (
            SELECT count(*) AS allocation_count, count(d.quantity) AS known_count,
                sum(d.quantity) AS allocated_quantity, count(priced.id) AS priced_count
            FROM bom_line_distribution d
            LEFT JOIN estimate_line priced
                ON priced.estimate_id = estimate_key AND priced.bom_line_distribution_id = d.id
            WHERE d.bom_line_id = bl.id
        ) allocation
        WHERE el.estimate_id = estimate_key AND el.bom_line_distribution_id IS NOT NULL
        AND (bl.pricing_basis = 'lump_sum' OR bl.quantity IS NULL OR bl.unit_code IS NULL
            OR allocation.known_count <> allocation.allocation_count
            OR allocation.priced_count <> allocation.allocation_count
            OR allocation.allocated_quantity IS DISTINCT FROM bl.quantity)
    ) THEN
        RAISE EXCEPTION 'Room pricing requires all allocations to be priced and sum to a measured BOM quantity'
            USING ERRCODE = '23514';
    END IF;
END;
$$;

CREATE FUNCTION guard_quote() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    estimate_key uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.estimate_id ELSE NEW.estimate_id END;
    estimate_header estimate%ROWTYPE;
    scale_amount integer;
    tax_rounding text;
    calculated_net numeric;
    calculated_tax numeric;
BEGIN
    PERFORM lock_project(project_id) FROM estimate WHERE id = estimate_key;
    IF TG_OP <> 'INSERT' AND OLD.status <> 'draft' THEN
        IF TG_OP = 'UPDATE' AND OLD.status = 'issued' AND NEW.status = 'superseded'
            AND to_jsonb(OLD) - 'status' = to_jsonb(NEW) - 'status' THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'An issued quote snapshot is immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;

    SELECT * INTO estimate_header FROM estimate WHERE id = estimate_key;
    IF NEW.currency <> estimate_header.currency THEN
        RAISE EXCEPTION 'A quote must use the currency of its estimate' USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT FROM quote q JOIN estimate e ON e.id = q.estimate_id
        WHERE e.project_id = estimate_header.project_id AND q.quote_number = NEW.quote_number
        AND q.revision_no = NEW.revision_no AND q.id <> NEW.id
    ) THEN
        RAISE EXCEPTION 'A quote number and revision must be unique within the project' USING ERRCODE = '23505';
    END IF;

    IF NEW.status = 'draft' THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' OR NEW.status <> 'issued' THEN
        RAISE EXCEPTION 'Create a draft before issuing a quote' USING ERRCODE = '23514';
    END IF;
    IF estimate_header.status NOT IN ('approved', 'locked') THEN
        RAISE EXCEPTION 'Approve the estimate before issuing a quote' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT FROM quote_line WHERE quote_id = NEW.id) THEN
        RAISE EXCEPTION 'An issued quote needs at least one line' USING ERRCODE = '23514';
    END IF;

    PERFORM validate_estimate_for_quote(estimate_key);

    IF EXISTS (
        SELECT FROM quote_line ql JOIN bom_line bl ON bl.id = ql.bom_line_id
        JOIN bom_version v ON v.id = bl.bom_version_id
        WHERE ql.quote_id = NEW.id AND (
            NOT EXISTS (
                SELECT FROM estimate_line el WHERE el.estimate_id = estimate_key AND el.bom_line_id = bl.id
            )
            OR (ql.included_in_total AND NOT EXISTS (
                SELECT FROM estimate_line el WHERE el.estimate_id = estimate_key
                AND el.bom_line_id = bl.id AND el.included_in_total
            ))
            OR (bl.total_rule = 'unit_price_only' AND (ql.included_in_total OR ql.net_amount IS NOT NULL))
            OR (v.phase = 'tender' AND (
                (bl.quantity IS NOT NULL AND ql.quantity IS DISTINCT FROM bl.quantity)
                OR (bl.unit_code IS NOT NULL AND ql.unit_code IS DISTINCT FROM bl.unit_code)
            ))
        )
    ) THEN
        RAISE EXCEPTION 'Quote lines must follow their estimate, tender quantities, units, and inclusion rules'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.pricing_policy IS NOT NULL AND jsonb_typeof(NEW.pricing_policy) <> 'object' THEN
        RAISE EXCEPTION 'Pricing policy must be a JSON object' USING ERRCODE = '23514';
    END IF;
    scale_amount := COALESCE((NEW.pricing_policy ->> 'amount_scale')::integer, 2);
    tax_rounding := COALESCE(NEW.pricing_policy ->> 'tax_rounding', 'rate_total');
    IF scale_amount NOT BETWEEN 0 AND 6 OR tax_rounding NOT IN ('line', 'rate_total') THEN
        RAISE EXCEPTION 'Invalid quote rounding policy' USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT FROM quote_line WHERE quote_id = NEW.id AND quantity IS NOT NULL
        AND net_amount <> round(quantity * sell_unit_price, scale_amount)
    ) THEN
        RAISE EXCEPTION 'Quote line amount does not match its quantity and selling price' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(sum(net_amount), 0) INTO calculated_net FROM quote_line
    WHERE quote_id = NEW.id AND included_in_total;
    IF tax_rounding = 'line' THEN
        SELECT COALESCE(sum(round(net_amount * tax_rate, scale_amount)), 0)
        INTO calculated_tax FROM quote_line WHERE quote_id = NEW.id AND included_in_total;
    ELSE
        SELECT COALESCE(sum(rate_tax), 0) INTO calculated_tax FROM (
            SELECT round(sum(net_amount) * tax_rate, scale_amount) AS rate_tax
            FROM quote_line WHERE quote_id = NEW.id AND included_in_total GROUP BY tax_rate
        ) totals_by_rate;
    END IF;

    IF (NEW.net_total IS NOT NULL AND NEW.net_total <> calculated_net)
        OR (NEW.tax_total IS NOT NULL AND NEW.tax_total <> calculated_tax)
        OR (NEW.gross_total IS NOT NULL AND NEW.gross_total <> calculated_net + calculated_tax) THEN
        RAISE EXCEPTION 'Quote totals do not reconcile to the included lines' USING ERRCODE = '23514';
    END IF;

    NEW.pricing_policy := COALESCE(NEW.pricing_policy, '{}'::jsonb)
        || jsonb_build_object('amount_scale', scale_amount, 'tax_rounding', tax_rounding);
    NEW.issued_at := COALESCE(NEW.issued_at, now());
    NEW.net_total := calculated_net;
    NEW.tax_total := calculated_tax;
    NEW.gross_total := calculated_net + calculated_tax;
    IF estimate_header.status <> 'locked' THEN
        UPDATE estimate SET status = 'locked' WHERE id = estimate_key;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_quote BEFORE INSERT OR UPDATE OR DELETE ON quote
FOR EACH ROW EXECUTE FUNCTION guard_quote();

CREATE FUNCTION guard_quote_line() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    quote_key uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.quote_id ELSE NEW.quote_id END;
    quote_header quote%ROWTYPE;
BEGIN
    PERFORM lock_project(e.project_id) FROM quote q JOIN estimate e ON e.id = q.estimate_id
    WHERE q.id = quote_key;
    SELECT * INTO quote_header FROM quote WHERE id = quote_key;
    IF quote_header.status <> 'draft' THEN
        RAISE EXCEPTION 'An issued quote snapshot is immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;

    IF NEW.bom_line_id IS NOT NULL AND NOT EXISTS (
        SELECT FROM estimate_line WHERE estimate_id = quote_header.estimate_id AND bom_line_id = NEW.bom_line_id
    ) THEN
        RAISE EXCEPTION 'A quote line must reference a BOM line used by its estimate' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER guard_quote_line BEFORE INSERT OR UPDATE OR DELETE ON quote_line
FOR EACH ROW EXECUTE FUNCTION guard_quote_line();
