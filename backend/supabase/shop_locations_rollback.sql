-- Rollback for shop_locations.sql. Off-campus shops become campus shops again
-- in the listing (their address and pin stay). Re-run tut_campuses.sql's
-- discover_shops afterwards (tut_campuses.sql is safe to re-run).
drop trigger if exists trg_check_store_location on public.stores;
drop function if exists public.check_store_location();
alter table public.stores drop constraint if exists stores_location_type_check;
alter table public.stores drop column if exists location_type;
