-- ============================================================
-- CLICKFOOD, privacy fixes + versioned Terms / Privacy acceptance
-- (2026-10-17). Needs account_deletion.sql and open_signup_students.sql.
--
-- 1. Deleting an account (profile becomes role 'deleted') now also removes
--    the contact details copied onto that customer's past orders (phone,
--    name, student number, room, building, instructions, cancel note) and
--    their student verification records. The orders themselves stay for
--    accounting and refunds, as the Privacy Policy says.
-- 2. legal_acceptances: one row per person per document version they
--    accepted (never overwritten). The current versions live in
--    legal_versions(); the app asks again when a version changes.
-- Safe to run more than once. Rollback: privacy_legal_rollback.sql
-- ============================================================

-- ---------- 1. scrub orders on account deletion ----------
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
revoke all on function public.scrub_deleted_customer() from public, anon, authenticated;
drop trigger if exists trg_scrub_deleted_customer on public.profiles;
create trigger trg_scrub_deleted_customer after update of role on public.profiles
  for each row execute function public.scrub_deleted_customer();

-- accounts already deleted before this file
update public.orders o
   set delivery_location = coalesce(o.delivery_location, '{}'::jsonb) - 'phone' - 'customerName' - 'studentNumber' - 'room' - 'building' - 'instructions',
       cancel_note = null
  from public.profiles p
 where p.id = o.customer_id and p.role = 'deleted'
   and (o.delivery_location ?| array['phone', 'customerName', 'studentNumber', 'room', 'building', 'instructions'] or o.cancel_note is not null);

-- ---------- 2. Terms / Privacy acceptance ----------
create or replace function public.legal_versions()
returns jsonb language sql immutable as $$ select '{"terms": "2026-10-17", "privacy": "2026-10-17"}'::jsonb $$;
grant execute on function public.legal_versions() to anon, authenticated;

create table if not exists public.legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  document text not null check (document in ('terms', 'privacy')),
  version text not null check (version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  accepted_at timestamptz not null default now(),
  unique (user_id, document, version)
);
alter table public.legal_acceptances enable row level security;
revoke all on public.legal_acceptances from anon, authenticated;
grant select on public.legal_acceptances to authenticated;
drop policy if exists "legal acceptances own" on public.legal_acceptances;
create policy "legal acceptances own" on public.legal_acceptances for select to authenticated
  using (user_id = auth.uid() or public."current_role"() = 'developer');

-- what the signed-in person still has to accept ({} = nothing)
create or replace function public.my_legal_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'terms', not exists (select 1 from public.legal_acceptances where user_id = auth.uid() and document = 'terms' and version = public.legal_versions()->>'terms'),
    'privacy', not exists (select 1 from public.legal_acceptances where user_id = auth.uid() and document = 'privacy' and version = public.legal_versions()->>'privacy'),
    'versions', public.legal_versions())
$$;
revoke all on function public.my_legal_status() from public, anon;
grant execute on function public.my_legal_status() to authenticated;

-- the person agrees to the CURRENT versions (older rows are kept)
create or replace function public.accept_legal()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb := public.legal_versions();
begin
  if auth.uid() is null or not exists (select 1 from public.profiles where id = auth.uid()) then
    return jsonb_build_object('ok', false, 'error', 'Please sign in.');
  end if;
  insert into public.legal_acceptances (user_id, document, version) values
    (auth.uid(), 'terms', v->>'terms'), (auth.uid(), 'privacy', v->>'privacy')
  on conflict (user_id, document, version) do nothing;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.accept_legal() from public, anon;
grant execute on function public.accept_legal() to authenticated;
