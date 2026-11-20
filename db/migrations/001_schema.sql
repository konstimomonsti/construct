CREATE TABLE project (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    reference text,
    default_currency char(3) NOT NULL DEFAULT 'EUR' CHECK (default_currency ~ '^[A-Z]{3}$')
);

CREATE TABLE project_area (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES project (id),
    parent_area_id uuid,
    name text NOT NULL,
    kind text NOT NULL,
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id, parent_area_id) REFERENCES project_area (project_id, id),
    CHECK (parent_area_id <> id)
);

CREATE TABLE source_document (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES project (id),
    filename text NOT NULL,
    storage_key text NOT NULL,
    sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    format text NOT NULL,
    format_version text,
    exchange_phase text,
    import_status text NOT NULL DEFAULT 'pending',
    import_notes jsonb,
    UNIQUE (project_id, sha256),
    UNIQUE (project_id, id)
);

CREATE TABLE bom_version (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES project (id),
    package_code text NOT NULL,
    version_no integer NOT NULL,
    previous_version_id uuid,
    title text NOT NULL,
    phase text,
    review_status text NOT NULL DEFAULT 'draft' CHECK (review_status IN ('draft', 'in_review', 'approved')),
    scope_notes text,
    UNIQUE (project_id, package_code, version_no),
    UNIQUE (project_id, package_code, id),
    FOREIGN KEY (project_id, package_code, previous_version_id) REFERENCES bom_version (project_id, package_code, id),
    CHECK (version_no > 0),
    CHECK (previous_version_id <> id)
);

CREATE TABLE bom_source (
    bom_version_id uuid NOT NULL REFERENCES bom_version (id),
    source_document_id uuid NOT NULL REFERENCES source_document (id),
    role text NOT NULL CHECK (role IN ('primary_scope', 'companion', 'annex', 'extract')),
    PRIMARY KEY (bom_version_id, source_document_id)
);

CREATE TABLE bom_section (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bom_version_id uuid NOT NULL REFERENCES bom_version (id),
    parent_section_id uuid,
    display_code text,
    title text NOT NULL,
    sort_order integer NOT NULL,
    scope_notes text,
    UNIQUE (bom_version_id, id),
    FOREIGN KEY (bom_version_id, parent_section_id) REFERENCES bom_section (bom_version_id, id),
    CHECK (parent_section_id <> id)
);

CREATE TABLE bom_line (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bom_version_id uuid NOT NULL REFERENCES bom_version (id),
    section_id uuid,
    line_code text,
    sort_order integer NOT NULL,
    short_description text NOT NULL,
    long_description text,
    quantity numeric,
    unit_code text,
    raw_unit text,
    pricing_basis text NOT NULL DEFAULT 'unit_rate' CHECK (pricing_basis IN ('unit_rate', 'lump_sum')),
    total_rule text NOT NULL DEFAULT 'include' CHECK (total_rule IN ('include', 'conditional', 'unit_price_only')),
    alternative_for_line_id uuid,
    classification_status text NOT NULL DEFAULT 'pending' CHECK (classification_status IN ('pending', 'reviewed')),
    source_document_id uuid,
    source_locator jsonb,
    UNIQUE (bom_version_id, id),
    FOREIGN KEY (bom_version_id, section_id) REFERENCES bom_section (bom_version_id, id),
    FOREIGN KEY (bom_version_id, alternative_for_line_id) REFERENCES bom_line (bom_version_id, id),
    FOREIGN KEY (bom_version_id, source_document_id) REFERENCES bom_source (bom_version_id, source_document_id),
    CHECK (alternative_for_line_id <> id),
    CHECK (source_locator IS NULL OR source_document_id IS NOT NULL)
);

CREATE TABLE bom_line_distribution (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bom_line_id uuid NOT NULL REFERENCES bom_line (id),
    area_id uuid NOT NULL REFERENCES project_area (id),
    quantity numeric,
    UNIQUE (bom_line_id, area_id),
    UNIQUE (bom_line_id, id)
);

CREATE TABLE material_group (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES project (id),
    name text NOT NULL,
    UNIQUE (project_id, name)
);

CREATE TABLE material_item (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bom_line_id uuid NOT NULL REFERENCES bom_line (id),
    material_group_id uuid REFERENCES material_group (id),
    name text NOT NULL,
    quantity numeric,
    unit_code text
);

CREATE TABLE activity_group (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES project (id),
    name text NOT NULL,
    UNIQUE (project_id, name)
);

CREATE TABLE activity_item (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bom_line_id uuid NOT NULL REFERENCES bom_line (id),
    activity_group_id uuid REFERENCES activity_group (id),
    name text NOT NULL,
    quantity numeric,
    unit_code text
);

CREATE TABLE reference_price (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_document_id uuid NOT NULL REFERENCES source_document (id),
    source_line_code text,
    source_locator jsonb NOT NULL,
    bom_line_id uuid REFERENCES bom_line (id),
    price_date date,
    currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    quantity numeric,
    unit_code text,
    unit_price numeric,
    reported_line_amount numeric
);

CREATE TABLE risk_finding (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES project (id),
    area_id uuid,
    bom_line_id uuid REFERENCES bom_line (id),
    category text NOT NULL,
    description text NOT NULL,
    severity text NOT NULL,
    status text NOT NULL,
    mitigation text,
    source_document_id uuid,
    source_locator jsonb,
    FOREIGN KEY (project_id, area_id) REFERENCES project_area (project_id, id),
    FOREIGN KEY (project_id, source_document_id) REFERENCES source_document (project_id, id),
    CHECK (source_locator IS NULL OR source_document_id IS NOT NULL)
);

CREATE TABLE estimate (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES project (id),
    scenario_name text NOT NULL,
    version_no integer NOT NULL,
    currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'locked')),
    UNIQUE (project_id, scenario_name, version_no),
    CHECK (version_no > 0)
);

CREATE TABLE estimate_line (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    estimate_id uuid NOT NULL REFERENCES estimate (id),
    bom_line_id uuid NOT NULL REFERENCES bom_line (id),
    bom_line_distribution_id uuid,
    quantity numeric,
    included_in_total boolean NOT NULL,
    UNIQUE (estimate_id, id),
    UNIQUE (estimate_id, bom_line_distribution_id),
    FOREIGN KEY (bom_line_id, bom_line_distribution_id) REFERENCES bom_line_distribution (bom_line_id, id)
);

CREATE TABLE cost_component (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    estimate_id uuid NOT NULL REFERENCES estimate (id),
    estimate_line_id uuid,
    material_item_id uuid REFERENCES material_item (id),
    activity_item_id uuid REFERENCES activity_item (id),
    risk_finding_id uuid REFERENCES risk_finding (id),
    category text NOT NULL CHECK (category IN ('labor', 'materials', 'equipment', 'subcontractor', 'overhead', 'risk', 'other')),
    description text NOT NULL,
    resource_quantity numeric,
    resource_unit text,
    unit_cost numeric,
    amount numeric NOT NULL,
    rate_source text,
    FOREIGN KEY (estimate_id, estimate_line_id) REFERENCES estimate_line (estimate_id, id),
    CHECK (num_nonnulls(material_item_id, activity_item_id) <= 1),
    CHECK (estimate_line_id IS NOT NULL OR num_nonnulls(material_item_id, activity_item_id) = 0)
);

CREATE TABLE quote (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    estimate_id uuid NOT NULL REFERENCES estimate (id),
    quote_number text NOT NULL,
    revision_no integer NOT NULL,
    customer_name text NOT NULL,
    currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'superseded')),
    issued_at timestamptz,
    pricing_policy jsonb,
    net_total numeric,
    tax_total numeric,
    gross_total numeric,
    CHECK (revision_no > 0),
    CHECK (status = 'draft' OR num_nonnulls(issued_at, net_total, tax_total, gross_total) = 4),
    CHECK (gross_total = net_total + tax_total)
);

CREATE TABLE quote_line (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id uuid NOT NULL REFERENCES quote (id),
    bom_line_id uuid REFERENCES bom_line (id),
    display_code text,
    description text NOT NULL,
    quantity numeric,
    unit_code text,
    sell_unit_price numeric NOT NULL,
    net_amount numeric,
    included_in_total boolean NOT NULL,
    tax_rate numeric NOT NULL,
    sort_order integer NOT NULL,
    UNIQUE (quote_id, bom_line_id),
    CHECK (tax_rate BETWEEN 0 AND 1),
    CHECK (NOT included_in_total OR (quantity IS NOT NULL AND net_amount IS NOT NULL))
);

CREATE UNIQUE INDEX estimate_line_once_whole
    ON estimate_line (estimate_id, bom_line_id)
    WHERE bom_line_distribution_id IS NULL;

CREATE INDEX project_area_by_parent ON project_area (project_id, parent_area_id);
CREATE INDEX bom_section_by_parent ON bom_section (bom_version_id, parent_section_id, sort_order);
CREATE INDEX bom_line_by_section ON bom_line (bom_version_id, section_id, sort_order);
CREATE INDEX material_item_by_line ON material_item (bom_line_id);
CREATE INDEX activity_item_by_line ON activity_item (bom_line_id);
CREATE INDEX estimate_line_by_bom ON estimate_line (estimate_id, bom_line_id);
CREATE INDEX estimate_line_by_bom_line ON estimate_line (bom_line_id);
CREATE INDEX cost_component_by_estimate_line ON cost_component (estimate_id, estimate_line_id);
CREATE INDEX quote_by_estimate ON quote (estimate_id);
