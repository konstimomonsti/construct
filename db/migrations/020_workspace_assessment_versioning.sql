-- Workspace assessment versioning, claim leasing, and bounded retries
ALTER TABLE workspace_assessment DROP CONSTRAINT IF EXISTS workspace_assessment_state_check;
ALTER TABLE workspace_assessment DROP CONSTRAINT IF EXISTS workspace_assessment_check;

ALTER TABLE workspace_assessment
    ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS assessed_revision integer,
    ADD COLUMN IF NOT EXISTS retries integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

ALTER TABLE workspace_assessment
    ADD CONSTRAINT workspace_assessment_state_check
    CHECK (state IN ('queued', 'running', 'ready', 'failed', 'stale', 'partial'));

CREATE INDEX IF NOT EXISTS workspace_assessment_claim_idx
    ON workspace_assessment (workspace, state, claimed_at);
