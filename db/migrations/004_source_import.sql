ALTER TABLE source_document ADD UNIQUE (id, sha256);

CREATE TABLE source_file (
    source_document_id uuid PRIMARY KEY,
    content bytea NOT NULL,
    sha256 char(64) GENERATED ALWAYS AS (encode(sha256(content), 'hex')) STORED NOT NULL,
    FOREIGN KEY (source_document_id, sha256) REFERENCES source_document (id, sha256)
);

CREATE TABLE source_import (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_document_id uuid NOT NULL REFERENCES source_file (source_document_id),
    parser_version text NOT NULL,
    status text NOT NULL CHECK (status IN ('processing', 'parsed', 'review', 'failed')),
    imported_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (source_document_id, parser_version)
);

CREATE TABLE source_extract (
    import_id uuid NOT NULL REFERENCES source_import ON DELETE CASCADE,
    ordinal integer NOT NULL CHECK (ordinal > 0),
    kind text NOT NULL,
    locator jsonb NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (import_id, ordinal)
);

CREATE INDEX source_extract_by_kind ON source_extract (import_id, kind);
