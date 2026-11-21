ALTER TABLE product ADD COLUMN archived_at timestamptz;
ALTER TABLE supplier ADD COLUMN archived_at timestamptz;
ALTER TABLE subcontractor ADD COLUMN archived_at timestamptz;
