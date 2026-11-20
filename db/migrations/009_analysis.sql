-- Pricing hand-off for the analysis pipeline and stored analysis results.
-- See docs/ANALYSIS_CONTRACT.md.

CREATE TABLE line_pricing (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bom_line_id uuid NOT NULL REFERENCES bom_line (id),
    is_current boolean NOT NULL DEFAULT true,
    unit_price numeric,
    currency char(3) CHECK (currency ~ '^[A-Z]{3}$'),
    price_unit text,
    line_amount numeric,
    source text NOT NULL DEFAULT 'none' CHECK (source IN ('catalogue', 'reference', 'ai', 'client', 'none')),
    source_ref text,
    matched_text text,
    match_confidence numeric CHECK (match_confidence BETWEEN 0 AND 1),
    price_date date,
    reference_min numeric,
    reference_median numeric,
    reference_max numeric,
    reference_count integer CHECK (reference_count >= 0),
    citations text[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
);

-- One current price per line. Older rows stay as history.
CREATE UNIQUE INDEX line_pricing_one_current ON line_pricing (bom_line_id) WHERE is_current;

CREATE TABLE analysis_run (
    id uuid PRIMARY KEY,
    bom_version_id uuid NOT NULL REFERENCES bom_version (id),
    schema_version text NOT NULL,
    input_hash char(64) NOT NULL,
    layers_run integer[] NOT NULL,
    summary jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE analysis_finding (
    run_id uuid NOT NULL REFERENCES analysis_run (id) ON DELETE CASCADE,
    finding_key text NOT NULL,
    bom_version_id uuid NOT NULL REFERENCES bom_version (id),
    layer smallint NOT NULL CHECK (layer IN (1, 2, 3)),
    rule_id text NOT NULL,
    severity text NOT NULL CHECK (severity IN ('error', 'warning', 'info')),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'applied', 'stale')),
    bom_line_id uuid REFERENCES bom_line (id),
    payload jsonb NOT NULL,
    decided_by text,
    decided_at timestamptz,
    PRIMARY KEY (run_id, finding_key),
    CHECK ((status IN ('open', 'stale')) = (decided_at IS NULL))
);

CREATE INDEX analysis_run_by_bom ON analysis_run (bom_version_id, created_at DESC);
CREATE INDEX analysis_finding_by_key ON analysis_finding (bom_version_id, finding_key);
CREATE INDEX analysis_finding_by_line ON analysis_finding (bom_line_id);
