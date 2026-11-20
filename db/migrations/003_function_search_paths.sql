-- Resolve trigger dependencies against the application schema regardless of a client's search path.
ALTER FUNCTION public.lock_project(uuid) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.protect_ownership() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.check_hierarchy_cycle() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.guard_bom_scope() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.check_bom_source_project() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.check_risk_project() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.guard_estimate() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.guard_estimate_detail() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.validate_estimate_for_quote(uuid) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.guard_quote() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.guard_quote_line() SET search_path TO pg_catalog, public, pg_temp;
