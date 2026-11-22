-- Reassess stored reports whose workspace findings changed.
UPDATE workspace_assessment a
SET state = 'queued', retries = 0, claimed_at = NULL
FROM workspace_record lists
WHERE (lists.workspace, lists.collection, lists.record_id) = (a.workspace, a.collection, a.list_id)
  AND a.state IN ('ready', 'failed')
  AND (
      a.report->'findings' @> '[{"rule_id": "L1.TEXT.SPEC_PLACEHOLDER"}]'::jsonb
      OR a.report->'findings' @> '[{"rule_id": "L1.TEXT.SPELLING_VARIANT"}]'::jsonb
      OR a.report->'findings' @> '[{"rule_id": "L1.TEXT.NOTATION_VARIANT"}]'::jsonb
      OR (
          lists.value->'source'->>'kind' = 'pdf'
          AND coalesce(lists.value->>'phase', '') !~* '^[XD]?(84|86)$'
          AND a.report->'findings' @> '[{"rule_id": "L1.QTY.ZERO", "severity": "warning"}]'::jsonb
      )
  );
