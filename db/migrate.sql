-- Apply migrations in order. Schema changes and their ledger entries commit together.
BEGIN;
SELECT pg_advisory_xact_lock(26641, 1);
CREATE SCHEMA IF NOT EXISTS db_migration;
CREATE TABLE IF NOT EXISTS db_migration.applied_version (
    version integer PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

SELECT NOT EXISTS (
    SELECT FROM db_migration.applied_version WHERE version = 1
) AS apply_schema \gset
\if :apply_schema
    \ir migrations/001_schema.sql
    INSERT INTO db_migration.applied_version (version) VALUES (1);
\endif

SELECT NOT EXISTS (
    SELECT FROM db_migration.applied_version WHERE version = 2
) AS apply_integrity \gset
\if :apply_integrity
    \ir migrations/002_integrity.sql
    INSERT INTO db_migration.applied_version (version) VALUES (2);
\endif

SELECT NOT EXISTS (
    SELECT FROM db_migration.applied_version WHERE version = 3
) AS apply_function_paths \gset
\if :apply_function_paths
    \ir migrations/003_function_search_paths.sql
    INSERT INTO db_migration.applied_version (version) VALUES (3);
\endif

SELECT NOT EXISTS (
    SELECT FROM db_migration.applied_version WHERE version = 4
) AS apply_source_import \gset
\if :apply_source_import
    \ir migrations/004_source_import.sql
    INSERT INTO db_migration.applied_version (version) VALUES (4);
\endif

SELECT NOT EXISTS (
    SELECT FROM db_migration.applied_version WHERE version = 5
) AS apply_group_hierarchies \gset
\if :apply_group_hierarchies
    \ir migrations/005_group_hierarchies.sql
    INSERT INTO db_migration.applied_version (version) VALUES (5);
\endif

SELECT NOT EXISTS (
    SELECT FROM db_migration.applied_version WHERE version = 6
) AS apply_product_catalogue \gset
\if :apply_product_catalogue
    \ir migrations/006_product_catalogue.sql
    INSERT INTO db_migration.applied_version (version) VALUES (6);
\endif

SELECT NOT EXISTS (
    SELECT FROM db_migration.applied_version WHERE version = 7
) AS apply_catalogue_price_sources \gset
\if :apply_catalogue_price_sources
    \ir migrations/007_catalogue_price_sources.sql
    INSERT INTO db_migration.applied_version (version) VALUES (7);
\endif

SELECT NOT EXISTS (
    SELECT FROM db_migration.applied_version WHERE version = 8
) AS apply_catalogue_import \gset
\if :apply_catalogue_import
    \ir migrations/008_catalogue_import.sql
    INSERT INTO db_migration.applied_version (version) VALUES (8);
\endif

-- Development databases created before the analysis merge recorded version 9 for the
-- draft columns, so the analysis tables are also applied whenever they are missing.
SELECT NOT EXISTS (
    SELECT FROM db_migration.applied_version WHERE version = 9
) OR to_regclass('public.analysis_run') IS NULL AS apply_analysis \gset
\if :apply_analysis
    \ir migrations/009_analysis.sql
    INSERT INTO db_migration.applied_version (version) VALUES (9) ON CONFLICT DO NOTHING;
\endif

SELECT NOT EXISTS (
    SELECT FROM db_migration.applied_version WHERE version = 10
) AS apply_mvp_drafts \gset
\if :apply_mvp_drafts
    \ir migrations/010_mvp_drafts.sql
    INSERT INTO db_migration.applied_version (version) VALUES (10);
\endif

SELECT NOT EXISTS (
    SELECT FROM db_migration.applied_version WHERE version = 11
) AND to_regclass('public.catalogue_run') IS NULL AS apply_catalogue_analytics \gset
\if :apply_catalogue_analytics
    \ir migrations/010_catalogue_analytics.sql
\endif
-- Recorded as 11: it was merged under the version 10 already used by 010_mvp_drafts.sql.
INSERT INTO db_migration.applied_version (version) VALUES (11) ON CONFLICT DO NOTHING;

SELECT NOT EXISTS (
    SELECT FROM db_migration.applied_version WHERE version = 12
) AS apply_workspace_sync \gset
\if :apply_workspace_sync
    \ir migrations/012_workspace_sync.sql
    INSERT INTO db_migration.applied_version (version) VALUES (12);
\endif

SELECT NOT EXISTS (
    SELECT FROM db_migration.applied_version WHERE version = 13
) AS apply_workspace_catalogue \gset
\if :apply_workspace_catalogue
    \ir migrations/013_workspace_catalogue.sql
    INSERT INTO db_migration.applied_version (version) VALUES (13);
\endif

SELECT NOT EXISTS (
    SELECT FROM db_migration.applied_version WHERE version = 14
) AS apply_company_catalogues \gset
\if :apply_company_catalogues
    \ir migrations/014_company_catalogues.sql
    INSERT INTO db_migration.applied_version (version) VALUES (14);
\endif

SELECT NOT EXISTS (
    SELECT FROM db_migration.applied_version WHERE version = 15
) AS apply_catalogue_crud \gset
\if :apply_catalogue_crud
    \ir migrations/015_catalogue_crud.sql
    INSERT INTO db_migration.applied_version (version) VALUES (15);
\endif

SELECT NOT EXISTS (
    SELECT FROM db_migration.applied_version WHERE version = 16
) AS apply_workspace_assessment \gset
\if :apply_workspace_assessment
    \ir migrations/016_workspace_assessment.sql
    INSERT INTO db_migration.applied_version (version) VALUES (16);
\endif

SELECT NOT EXISTS (
    SELECT FROM db_migration.applied_version WHERE version = 19
) AS apply_subcontractor_billing_address \gset
\if :apply_subcontractor_billing_address
    \ir migrations/019_subcontractor_billing_address.sql
    INSERT INTO db_migration.applied_version (version) VALUES (19);
\endif

SELECT NOT EXISTS (
    SELECT FROM db_migration.applied_version WHERE version = 20
) AS apply_supplier_crm \gset
\if :apply_supplier_crm
    \ir migrations/020_supplier_crm.sql
    INSERT INTO db_migration.applied_version (version) VALUES (20);
\endif

SELECT NOT EXISTS (
    SELECT FROM db_migration.applied_version WHERE version = 21
) AS apply_workspace_assessment_versioning \gset
\if :apply_workspace_assessment_versioning
    \ir migrations/021_workspace_assessment_versioning.sql
    INSERT INTO db_migration.applied_version (version) VALUES (21);
\endif

\ir runtime_role.sql
COMMIT;
