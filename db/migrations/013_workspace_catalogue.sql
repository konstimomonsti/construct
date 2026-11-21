CREATE TABLE workspace_catalogue_run (
    workspace text NOT NULL,
    collection text GENERATED ALWAYS AS ('userLists'::text) STORED,
    list_id text NOT NULL,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'ready', 'failed')),
    PRIMARY KEY (workspace, list_id),
    FOREIGN KEY (workspace, collection, list_id)
        REFERENCES workspace_record (workspace, collection, record_id) ON DELETE CASCADE
);

CREATE TABLE workspace_catalogue_position (
    workspace text NOT NULL,
    list_id text NOT NULL,
    position_id text NOT NULL,
    state text NOT NULL CHECK (state IN (
        'matched', 'activity', 'needs_description', 'queued', 'researching', 'suggested', 'no_evidence', 'failed'
    )),
    input jsonb NOT NULL,
    product jsonb,
    suggestion jsonb,
    lease_until timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace, list_id, position_id),
    FOREIGN KEY (workspace, list_id) REFERENCES workspace_catalogue_run ON DELETE CASCADE
);

CREATE INDEX workspace_catalogue_pending ON workspace_catalogue_position (state, lease_until)
WHERE state IN ('queued', 'researching');
