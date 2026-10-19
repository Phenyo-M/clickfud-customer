-- Rollback for student_entrepreneurs.sql (applications are deleted; shops stay)
drop trigger if exists trg_a1_require_approved_entrepreneur on public.stores;
drop trigger if exists trg_link_entrepreneur_shop on public.stores;
drop function if exists public.require_approved_entrepreneur();
drop function if exists public.link_entrepreneur_shop();
drop function if exists public.dev_review_entrepreneur(uuid, text, text, boolean);
drop function if exists public.withdraw_entrepreneur_application();
drop function if exists public.save_entrepreneur_application(jsonb, boolean);
drop function if exists public.my_entrepreneur_status();
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'purge-entrepreneur-sensitive';
  end if;
end $$;
drop function if exists public.purge_entrepreneur_sensitive();
drop table if exists public.entrepreneur_demographics;
drop table if exists public.entrepreneur_applications;
drop function if exists public.entrepreneur_email(uuid);
alter table public.allowed_domains drop column if exists entrepreneur_eligible;
-- scrub_deleted_customer: back to the privacy_legal.sql version
create or replace function public.scrub_deleted_customer()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role = 'deleted' and old.role is distinct from 'deleted' then
    update public.orders
       set delivery_location = coalesce(delivery_location, '{}'::jsonb) - 'phone' - 'customerName' - 'studentNumber' - 'room' - 'building' - 'instructions',
           cancel_note = null
     where customer_id = new.id;
    delete from public.student_verifications where user_id = new.id;
  end if;
  return null;
end $$;
create or replace function public.legal_versions()
returns jsonb language sql immutable as $$ select '{"terms": "2026-10-17", "privacy": "2026-10-17"}'::jsonb $$;
