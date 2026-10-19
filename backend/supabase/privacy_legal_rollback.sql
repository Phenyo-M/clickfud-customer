-- Rollback for privacy_legal.sql (scrubbed order contact details are not restored)
drop trigger if exists trg_scrub_deleted_customer on public.profiles;
drop function if exists public.scrub_deleted_customer();
drop function if exists public.accept_legal();
drop function if exists public.my_legal_status();
drop table if exists public.legal_acceptances;
drop function if exists public.legal_versions();
