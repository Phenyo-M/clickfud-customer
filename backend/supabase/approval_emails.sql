-- ============================================================
-- ClickFood: automatic approval emails (2026-10-12)
--
-- Every admin approval writes one row to email_outbox from a database
-- trigger, so the email exists only if the approval was really saved
-- (a rolled-back approval leaves no row and sends nothing). pg_net then
-- calls the send-email Edge Function after the transaction commits; the
-- function sends through Resend and records the result.
--
-- Covered approvals:
--   student_shop_approved   stores (seller_kind student)  pending/rejected -> approved
--   business_shop_approved  stores (seller_kind business) pending/rejected -> approved
--   business_shop_live      stores (business) publish request approved (is_published false -> true)
--   driver_approved         profiles (role driver)        pending/rejected -> approved
--
-- Duplicates: the trigger only fires on the change INTO approved, so a
-- second click (already approved) adds nothing. Resend reuses the same
-- row, and the function claims a row atomically before sending.
--
-- Statuses: queued -> sending -> sent (accepted by Resend) | failed.
-- 'delivered' / 'bounced' need Resend's webhook (not set up yet), so
-- nothing is ever marked delivered here.
--
-- Safe to run more than once. Rollback: approval_emails_rollback.sql
-- ============================================================

create table if not exists public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  target_type text not null,
  target_id uuid not null,
  recipient_user uuid references public.profiles(id) on delete set null,
  recipient_email text not null,
  recipient_name text,
  data jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'delivered', 'bounced')),
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  sent_at timestamptz,
  provider_id text,
  error text,
  requested_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists email_outbox_target_idx on public.email_outbox (target_id, created_at desc);
create index if not exists email_outbox_status_idx on public.email_outbox (status, created_at);
alter table public.email_outbox enable row level security;
drop policy if exists "email outbox developer read" on public.email_outbox;
create policy "email outbox developer read" on public.email_outbox for select
  using (public."current_role"() = 'developer');
revoke insert, update, delete on public.email_outbox from anon, authenticated;
revoke all on public.email_outbox from anon;
grant select on public.email_outbox to authenticated;

-- Where to call and the shared secret. No policies: no app role can read it.
create table if not exists public.email_dispatch_config (
  id int primary key default 1 check (id = 1),
  function_url text not null,
  secret text not null
);
alter table public.email_dispatch_config enable row level security;
revoke all on public.email_dispatch_config from anon, authenticated;

-- Ask the Edge Function to send one outbox row (sent after commit by pg_net).
create or replace function public.dispatch_email(p_id uuid)
returns void language plpgsql security definer set search_path = public, net as $$
declare c public.email_dispatch_config;
begin
  select * into c from public.email_dispatch_config where id = 1;
  if not found then
    update public.email_outbox set status = 'failed', error = 'Email sending is not configured.', updated_at = now() where id = p_id;
    return;
  end if;
  perform net.http_post(
    url := c.function_url,
    body := jsonb_build_object('id', p_id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-email-secret', c.secret),
    timeout_milliseconds := 10000);
end $$;
revoke all on function public.dispatch_email(uuid) from public, anon, authenticated;

create or replace function public.queue_email(p_kind text, p_target_type text, p_target uuid, p_user uuid,
                                               p_email text, p_name text, p_data jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if coalesce(btrim(p_email), '') = '' then
    insert into public.email_outbox (kind, target_type, target_id, recipient_user, recipient_email, recipient_name, data, status, error, requested_by)
    values (p_kind, p_target_type, p_target, p_user, '', p_name, coalesce(p_data, '{}'), 'failed', 'No email address on file.', auth.uid())
    returning id into v_id;
    return v_id;
  end if;
  insert into public.email_outbox (kind, target_type, target_id, recipient_user, recipient_email, recipient_name, data, requested_by)
  values (p_kind, p_target_type, p_target, p_user, lower(btrim(p_email)), p_name, coalesce(p_data, '{}'), auth.uid())
  returning id into v_id;
  perform public.dispatch_email(v_id);
  return v_id;
end $$;
revoke all on function public.queue_email(text, text, uuid, uuid, text, text, jsonb) from public, anon, authenticated;

-- ---------- Shop approvals ----------
create or replace function public.email_on_store_approval()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_email text; v_name text;
begin
  select email, name into v_email, v_name from public.profiles where id = new.manager_id;
  v_email := coalesce(nullif(btrim(v_email), ''), nullif(btrim(new.manager_email), ''), nullif(btrim(new.contact_email), ''));
  v_name := coalesce(nullif(btrim(v_name), ''), new.manager_name);

  if new.status = 'approved' and old.status in ('pending', 'rejected') then
    perform public.queue_email(
      case when new.seller_kind = 'student' then 'student_shop_approved' else 'business_shop_approved' end,
      'store', new.id, new.manager_id, v_email, v_name,
      jsonb_build_object('shop_name', new.name, 'seller_kind', new.seller_kind));
  elsif new.seller_kind = 'business' and new.status = 'approved'
        and new.is_published and not coalesce(old.is_published, false) and old.publish_requested_at is not null then
    perform public.queue_email('business_shop_live', 'store', new.id, new.manager_id, v_email, v_name,
      jsonb_build_object('shop_name', new.name, 'seller_kind', new.seller_kind));
  end if;
  return new;
end $$;
drop trigger if exists trg_email_on_store_approval on public.stores;
create trigger trg_email_on_store_approval after update of status, is_published on public.stores
  for each row execute function public.email_on_store_approval();

-- ---------- Driver approvals ----------
create or replace function public.email_on_driver_approval()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role = 'driver' and new.status = 'approved' and old.status in ('pending', 'rejected') then
    perform public.queue_email('driver_approved', 'profile', new.id, new.id, new.email, new.name, '{}'::jsonb);
  end if;
  return new;
end $$;
drop trigger if exists trg_email_on_driver_approval on public.profiles;
create trigger trg_email_on_driver_approval after update of status on public.profiles
  for each row execute function public.email_on_driver_approval();

-- ---------- Resend (developer only, never changes the application) ----------
create or replace function public.resend_email(p_id uuid)
returns public.email_outbox language plpgsql security definer set search_path = public as $$
declare o public.email_outbox;
begin
  if public."current_role"() is distinct from 'developer' then
    raise exception 'Only ClickFood admins can resend emails.';
  end if;
  select * into o from public.email_outbox where id = p_id for update;
  if not found then raise exception 'Email not found.'; end if;
  if o.status in ('queued', 'sending') and o.last_attempt_at > now() - interval '2 minutes' then
    raise exception 'This email is already being sent.';
  end if;
  if coalesce(o.recipient_email, '') = '' then raise exception 'No email address on file.'; end if;
  update public.email_outbox set status = 'queued', error = null, requested_by = auth.uid(), updated_at = now()
   where id = p_id returning * into o;
  perform public.audit('resend_email', o.target_type, o.target_id, o.kind, 'to ' || o.recipient_email, null);
  perform public.dispatch_email(p_id);
  return o;
end $$;
revoke all on function public.resend_email(uuid) from public, anon;
grant execute on function public.resend_email(uuid) to authenticated;

-- ---------- Safety net: anything stuck in "queued" is retried ----------
create or replace function public.retry_stuck_emails()
returns integer language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select id from public.email_outbox
            where status = 'queued' and attempts < 3 and coalesce(last_attempt_at, created_at) < now() - interval '3 minutes'
            order by created_at limit 20 loop
    perform public.dispatch_email(r.id);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.retry_stuck_emails() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') and exists (select 1 from pg_proc where proname = 'schedule' and pronamespace = 'cron'::regnamespace) then
    perform cron.unschedule('retry-stuck-emails') where exists (select 1 from cron.job where jobname = 'retry-stuck-emails');
    perform cron.schedule('retry-stuck-emails', '*/5 * * * *', 'select public.retry_stuck_emails()');
  end if;
end $$;
