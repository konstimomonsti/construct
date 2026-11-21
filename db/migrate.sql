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

SELECT NOT EXISTS (
    SELECT FROM db_migration.applied_version WHERE version = 9
) AS apply_analysis \gset
\if :apply_analysis
    \ir migrations/009_analysis.sql
    INSERT INTO db_migration.applied_version (version) VALUES (9);
\endif

SELECT NOT EXISTS (
    SELECT FROM db_migration.applied_version WHERE version = 10
) AS apply_catalogue_analytics \gset
\if :apply_catalogue_analytics
    \ir migrations/010_catalogue_analytics.sql
    INSERT INTO db_migration.applied_version (version) VALUES (10);
\endif

\ir runtime_role.sql
COMMIT;
