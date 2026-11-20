-- Role passwords come from Compose. Dumps can be restored with the destination's credentials.
\getenv app_password POSTGRES_APP_PASSWORD

DO $$
BEGIN
    IF current_user = 'construction_app' THEN
        RAISE EXCEPTION 'Use a separate owner for migrations';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'construction_app') THEN
        CREATE ROLE construction_app;
    END IF;
END;
$$;

ALTER ROLE construction_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'app_password';
SELECT format('GRANT CONNECT ON DATABASE %I TO construction_app', current_database()) \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO construction_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO construction_app;
REVOKE UPDATE, DELETE ON source_file FROM construction_app;
