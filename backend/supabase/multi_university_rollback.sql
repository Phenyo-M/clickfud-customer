-- Rollback for multi_university.sql. Removes only what it added (home
-- university choices, shop university links, availability); existing
-- profiles.university / stores.university are untouched. Redeploy the
-- previous customer + developer apps first.
drop function if exists public.discover_shops(uuid);
drop function if exists public.set_store_universities(uuid, text, uuid[]);
drop function if exists public.set_my_home_university(uuid);
drop trigger if exists trg_protect_store_availability on public.stores;
drop function if exists public.protect_store_availability();
drop trigger if exists trg_store_home_university on public.stores;
drop function if exists public.store_home_university();
drop table if exists public.store_universities;
alter table public.stores drop constraint if exists stores_availability_check;
alter table public.stores drop column if exists availability;
drop index if exists public.stores_discovery;
drop trigger if exists trg_set_home_university on public.profiles;
drop function if exists public.set_home_university();
alter table public.profiles drop column if exists home_university_id;
drop trigger if exists trg_allowed_domain_university on public.allowed_domains;
drop function if exists public.allowed_domain_university();
alter table public.allowed_domains drop column if exists university_id;
drop function if exists public.ensure_university(text);
drop function if exists public.university_short_code(text);
drop table if exists public.universities;
