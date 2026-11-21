ALTER TABLE supplier
    ADD COLUMN contact_name text,
    ADD COLUMN email text,
    ADD COLUMN phone text;

CREATE TABLE subcontractor (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE CHECK (btrim(name) <> ''),
    trade text NOT NULL CHECK (btrim(trade) <> ''),
    contact_name text,
    email text,
    phone text
);
