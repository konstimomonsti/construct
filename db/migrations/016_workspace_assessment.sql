CREATE TABLE workspace_assessment (
    workspace text NOT NULL,
    collection text GENERATED ALWAYS AS ('userLists'::text) STORED,
    list_id text NOT NULL,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'ready', 'failed')),
    report jsonb,
    PRIMARY KEY (workspace, list_id),
    FOREIGN KEY (workspace, collection, list_id)
        REFERENCES workspace_record (workspace, collection, record_id) ON DELETE CASCADE,
    CHECK ((state = 'ready') = (report IS NOT NULL))
);

CREATE INDEX workspace_assessment_pending ON workspace_assessment (workspace, list_id) WHERE state = 'queued';

-- Review existing uploads once using their originally imported positions.
INSERT INTO workspace_assessment (workspace, list_id)
SELECT lists.workspace, lists.record_id FROM workspace_record lists
WHERE lists.collection = 'userLists'
  AND lists.value->'source'->>'kind' IN ('gaeb-xml', 'gaeb90', 'pdf', 'docx', 'csv', 'xlsx', 'json')
  AND CASE WHEN jsonb_typeof(lists.value->'positions') = 'array'
      THEN jsonb_array_length(lists.value->'positions') > 0 ELSE false END
  AND EXISTS (
      SELECT 1 FROM workspace_record doc
      WHERE doc.workspace = lists.workspace AND doc.collection = 'userDocuments'
        AND doc.value->>'original' = 'true' AND doc.value->>'listId' = lists.record_id
        AND doc.value->>'name' = lists.value->>'fileName'
  );
