-- Shared BillBuild workspace: folders, lists, edits and uploaded files synced between browsers.
-- Each record is stored separately so concurrent edits to different records merge cleanly.
CREATE TABLE IF NOT EXISTS workspace_sync (
    workspace text PRIMARY KEY CHECK (workspace ~ '^[a-z0-9-]{1,40}$'),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_record (
    workspace text NOT NULL REFERENCES workspace_sync ON DELETE CASCADE,
    collection text NOT NULL CHECK (collection ~ '^[A-Za-z]{1,40}$'),
    record_id text NOT NULL CHECK (length(record_id) BETWEEN 1 AND 200),
    value jsonb NOT NULL,
    revision bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace, collection, record_id)
);

CREATE TABLE IF NOT EXISTS workspace_file (
    workspace text NOT NULL REFERENCES workspace_sync ON DELETE CASCADE,
    file_id text NOT NULL CHECK (file_id ~ '^[A-Za-z0-9_-]{1,120}$'),
    content_type text NOT NULL,
    content bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace, file_id)
);

INSERT INTO workspace_sync (workspace) VALUES ('default') ON CONFLICT DO NOTHING;
