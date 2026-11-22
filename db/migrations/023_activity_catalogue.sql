-- Activity catalogue: work items (installation, removal, disposal, planning, site costs, labour, vehicles)
-- priced either by us (subcontractor_id IS NULL) or by a subcontractor from an offer.

CREATE TABLE activity (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Standard position number of the tender catalogue, for example 02.01.4010.
    code text NOT NULL UNIQUE CHECK (btrim(code) <> ''),
    -- 'supply' marks a delivery position that a subcontractor priced (for example supply and install).
    kind text NOT NULL DEFAULT 'activity' CHECK (kind IN ('activity', 'supply')),
    name text NOT NULL CHECK (btrim(name) <> ''),
    description text CHECK (btrim(description) <> ''),
    unit_code text CHECK (btrim(unit_code) <> ''),
    category text CHECK (btrim(category) <> ''),
    archived_at timestamptz
);

CREATE TABLE activity_price (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    activity_id uuid NOT NULL REFERENCES activity (id),
    -- NULL means our own price.
    subcontractor_id uuid REFERENCES subcontractor (id),
    valid_from date NOT NULL CHECK (isfinite(valid_from)),
    valid_until date CHECK (valid_until IS NULL OR valid_until >= valid_from),
    currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    unit_price numeric NOT NULL CHECK (unit_price >= 0 AND unit_price < 'Infinity'::numeric),
    source_note text CHECK (btrim(source_note) <> ''),
    UNIQUE NULLS NOT DISTINCT (activity_id, subcontractor_id, currency, valid_from)
);

CREATE INDEX activity_by_category ON activity (category, name);
CREATE INDEX activity_price_by_subcontractor ON activity_price (subcontractor_id) WHERE subcontractor_id IS NOT NULL;
