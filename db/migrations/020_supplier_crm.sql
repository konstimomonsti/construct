-- Supplier relationship log: which categories a supplier delivers, what we sent, what came back, reminders.

-- Explicit "this supplier delivers this kind of good". Suppliers with an active catalogue product in a
-- category also count; this table adds suppliers that have no product rows yet.
CREATE TABLE supplier_category (
    supplier_id uuid NOT NULL REFERENCES supplier (id) ON DELETE CASCADE,
    category_id uuid NOT NULL REFERENCES product_category (id) ON DELETE CASCADE,
    PRIMARY KEY (supplier_id, category_id)
);

CREATE INDEX supplier_category_by_category ON supplier_category (category_id);

-- One row per contact with a supplier or subcontractor. A request (rfq_sent) is answered when a reply or
-- offer_received row points to it; answered_at then holds the reply time so response times are cheap to read.
CREATE TABLE communication (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    party_kind text NOT NULL CHECK (party_kind IN ('supplier', 'subcontractor')),
    party_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('rfq_sent', 'reply', 'offer_received', 'reminder_sent', 'call', 'note')),
    channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'phone', 'meeting', 'other')),
    list_id text CHECK (length(list_id) <= 200),
    list_title text CHECK (length(list_title) <= 300),
    subject text CHECK (length(subject) <= 500),
    note text CHECK (length(note) <= 4000),
    items jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(items) = 'array'),
    request_id uuid REFERENCES communication (id) ON DELETE SET NULL,
    due_at timestamptz,
    answered_at timestamptz,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    created_by text CHECK (length(created_by) <= 120)
);

CREATE INDEX communication_by_party ON communication (party_kind, party_id, occurred_at DESC);
CREATE INDEX communication_by_list ON communication (list_id, occurred_at DESC) WHERE list_id IS NOT NULL;
CREATE INDEX communication_open_requests ON communication (party_kind, party_id, occurred_at DESC)
WHERE kind = 'rfq_sent' AND answered_at IS NULL;

CREATE TABLE reminder (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    party_kind text NOT NULL CHECK (party_kind IN ('supplier', 'subcontractor')),
    party_id uuid NOT NULL,
    communication_id uuid REFERENCES communication (id) ON DELETE CASCADE,
    due_at timestamptz NOT NULL,
    note text CHECK (length(note) <= 1000),
    done_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text CHECK (length(created_by) <= 120)
);

CREATE INDEX reminder_open ON reminder (due_at) WHERE done_at IS NULL;

-- Category of a bill position that the catalogue could not match: chosen by the AI agent, a keyword
-- fallback, or the user. Catalogue matches are read live from workspace_catalogue_position instead.
CREATE TABLE position_category (
    workspace text NOT NULL,
    list_id text NOT NULL CHECK (length(list_id) <= 200),
    position_id text NOT NULL CHECK (length(position_id) <= 200),
    category_id uuid NOT NULL REFERENCES product_category (id) ON DELETE CASCADE,
    source text NOT NULL CHECK (source IN ('ai', 'keyword', 'user')),
    confidence numeric CHECK (confidence >= 0 AND confidence <= 1),
    reason text CHECK (length(reason) <= 500),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace, list_id, position_id)
);
