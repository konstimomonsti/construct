CREATE TABLE catalogue_product_spec (
    product_id uuid PRIMARY KEY REFERENCES product (id),
    category text NOT NULL,
    attributes jsonb NOT NULL CHECK (jsonb_typeof(attributes) = 'object'),
    provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object')
);

CREATE TABLE catalogue_product_alias (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id uuid NOT NULL REFERENCES product (id),
    project_id uuid REFERENCES project (id),
    normalized_name text NOT NULL CHECK (btrim(normalized_name) <> ''),
    approved_by text NOT NULL CHECK (btrim(approved_by) <> ''),
    UNIQUE NULLS NOT DISTINCT (product_id, project_id, normalized_name)
);

CREATE TABLE catalogue_run (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bom_version_id uuid NOT NULL REFERENCES bom_version (id),
    rule_version text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    summary jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX catalogue_run_by_bom ON catalogue_run (bom_version_id, created_at DESC);

CREATE TABLE catalogue_resolution (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES project (id),
    fingerprint text NOT NULL,
    specification jsonb NOT NULL,
    UNIQUE (project_id, fingerprint)
);

CREATE TABLE catalogue_attempt (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    resolution_id uuid NOT NULL REFERENCES catalogue_resolution (id),
    previous_attempt_id uuid,
    request_fingerprint text NOT NULL,
    request jsonb NOT NULL,
    model_id text NOT NULL,
    status text NOT NULL DEFAULT 'running' CHECK (
        status IN ('running', 'valid', 'invalid', 'unavailable', 'uncertain')
    ),
    lease_until timestamptz NOT NULL,
    response jsonb,
    metadata jsonb NOT NULL DEFAULT '{}',
    validation_error text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    finished_at timestamptz,
    UNIQUE (resolution_id, id),
    FOREIGN KEY (resolution_id, previous_attempt_id) REFERENCES catalogue_attempt (resolution_id, id),
    UNIQUE NULLS NOT DISTINCT (resolution_id, previous_attempt_id),
    CHECK ((status = 'running') = (finished_at IS NULL))
);

CREATE TABLE catalogue_decision (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    resolution_id uuid NOT NULL REFERENCES catalogue_resolution (id),
    previous_decision_id uuid,
    attempt_id uuid,
    outcome text NOT NULL CHECK (outcome IN ('matched', 'ambiguous', 'unmatched', 'invalid_input')),
    state text NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected', 'stale')),
    method text NOT NULL CHECK (method IN ('rule', 'llm', 'human')),
    product_id uuid REFERENCES product (id),
    product_identity text,
    evidence jsonb NOT NULL,
    reviewer text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (resolution_id, id),
    FOREIGN KEY (resolution_id, previous_decision_id) REFERENCES catalogue_decision (resolution_id, id),
    FOREIGN KEY (resolution_id, attempt_id) REFERENCES catalogue_attempt (resolution_id, id),
    UNIQUE NULLS NOT DISTINCT (resolution_id, previous_decision_id),
    CHECK (state <> 'accepted' OR (outcome = 'matched' AND product_id IS NOT NULL)),
    CHECK ((product_id IS NULL) = (product_identity IS NULL)),
    CHECK ((method = 'human') = (reviewer IS NOT NULL))
);

CREATE TABLE catalogue_occurrence (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bom_version_id uuid NOT NULL,
    bom_line_id uuid NOT NULL,
    slot integer NOT NULL CHECK (slot >= 0),
    extraction_version text NOT NULL,
    run_id uuid NOT NULL REFERENCES catalogue_run (id),
    resolution_id uuid NOT NULL REFERENCES catalogue_resolution (id),
    decision_id uuid,
    material_item_id uuid UNIQUE REFERENCES material_item (id),
    active boolean NOT NULL DEFAULT true,
    reused boolean NOT NULL DEFAULT false,
    candidate jsonb NOT NULL,
    FOREIGN KEY (bom_version_id, bom_line_id) REFERENCES bom_line (bom_version_id, id),
    FOREIGN KEY (resolution_id, decision_id) REFERENCES catalogue_decision (resolution_id, id),
    UNIQUE (bom_line_id, slot)
);
CREATE INDEX catalogue_occurrence_by_bom ON catalogue_occurrence (bom_version_id) WHERE active;
CREATE INDEX catalogue_occurrence_by_resolution ON catalogue_occurrence (resolution_id) WHERE active;
