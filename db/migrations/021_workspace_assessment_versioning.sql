-- Workspace assessment versioning, claim leasing, and bounded retries
ALTER TABLE workspace_assessment DROP CONSTRAINT IF EXISTS workspace_assessment_state_check;
ALTER TABLE workspace_assessment DROP CONSTRAINT IF EXISTS workspace_assessment_check;

ALTER TABLE workspace_assessment
    ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS assessed_revision bigint,
    ADD COLUMN IF NOT EXISTS retries integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
    ADD COLUMN IF NOT EXISTS rules_only boolean NOT NULL DEFAULT false;

-- Retain legacy reports for reference and regenerate without model calls.
-- Jobs are claimed one at a time. A new user revision supersedes the backfill.
UPDATE workspace_assessment a
SET state='queued', revision=GREATEST(w.revision, 1), rules_only=true
FROM workspace_sync w WHERE w.workspace=a.workspace;

ALTER TABLE workspace_assessment
    ADD CONSTRAINT workspace_assessment_state_check
    CHECK (state IN ('queued', 'running', 'ready', 'failed')),
    ADD CONSTRAINT workspace_assessment_publication_check
    CHECK (state <> 'ready' OR (report IS NOT NULL AND assessed_revision = revision AND assessed_revision IS NOT NULL));

CREATE INDEX IF NOT EXISTS workspace_assessment_claim_idx
    ON workspace_assessment (workspace, state, claimed_at);
