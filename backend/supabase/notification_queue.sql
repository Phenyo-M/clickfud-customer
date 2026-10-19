-- ============================================================
-- ClickFood: queue-based order notifications (2026-10-13)
-- Runs after every earlier migration (it replaces the notification part
-- of confirm_collection, seller_update_order, staff_cancel_order and
-- finalize_paystack_checkout, generated from their live versions).
--
-- Before: the kitchen's browser (and some database functions) wrote the
-- order notifications right after changing an order, so a dropped
-- connection lost them, and phone push never worked.
-- Now: an order change writes job rows into notification_jobs in the
-- SAME transaction (trigger trg_zz_queue_order_notifications). The
-- notify-worker Edge Function delivers them (in app, push, email; SMS is
-- built but switched off), with retries and a dead-letter state.
--
--   notification_jobs            the queue (only the server can touch it)
--   notification_channel_rules   which channels each event uses (edit here)
--   order_notification_events()  who hears about which order event (edit here)
--   notification_preferences     a user's own on/off per channel
--   notification_worker_config   worker URL + secret (filled in on deploy)
--
-- Untouched on purpose (they keep their own messages): missed collection
-- and reschedule, refunds, groups, budget, approvals, customer's own
-- cancel confirmation. Safe to run more than once. Rollback at the end.
-- ============================================================

-- ---------- 1. Queue ----------
create table if not exists public.notification_jobs (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  channel text not null check (channel in ('in_app', 'push', 'email', 'sms')),
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'sent', 'delivered', 'failed', 'dead', 'skipped')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  dedupe_key text not null,
  provider_message_id text,
  error text,
  created_at timestamptz not null default now(),
  locked_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz
);
create unique index if not exists notification_jobs_dedupe_key on public.notification_jobs (dedupe_key);
create index if not exists notification_jobs_due on public.notification_jobs (next_attempt_at) where status in ('queued', 'failed', 'processing');
create index if not exists notification_jobs_recipient on public.notification_jobs (recipient_id);
create index if not exists notification_jobs_provider_id on public.notification_jobs (provider_message_id) where provider_message_id is not null;
alter table public.notification_jobs enable row level security;
-- No policies: nobody but the server (service role, definer functions) reads or writes it.
revoke all on public.notification_jobs from anon, authenticated;

-- Errors inside the order trigger are written here instead of failing the order.
create table if not exists public.notification_errors (
  id bigint generated always as identity primary key,
  order_id uuid,
  error text,
  created_at timestamptz not null default now()
);
alter table public.notification_errors enable row level security;
revoke all on public.notification_errors from anon, authenticated;
drop policy if exists "notification errors developer read" on public.notification_errors;
create policy "notification errors developer read" on public.notification_errors for select
  using (public."current_role"() = 'developer');
grant select on public.notification_errors to authenticated;

-- ---------- 2. Channel rules (one place) ----------
create table if not exists public.notification_channel_rules (
  event_type text not null,
  audience text not null check (audience in ('customer', 'shop')),
  channel text not null check (channel in ('in_app', 'push', 'email', 'sms')),
  enabled boolean not null default true,
  primary key (event_type, audience, channel)
);
alter table public.notification_channel_rules enable row level security;
revoke all on public.notification_channel_rules from anon, authenticated;
insert into public.notification_channel_rules (event_type, audience, channel) values
  ('order_new',              'shop',     'in_app'), ('order_new',              'shop',     'push'),
  ('order_placed',           'customer', 'in_app'),
  ('order_preparing',        'customer', 'in_app'),
  ('order_ready',            'customer', 'in_app'), ('order_ready',            'customer', 'push'),
  ('order_collected',        'customer', 'in_app'), ('order_collected',        'customer', 'email'),
  ('order_cancelled',        'customer', 'in_app'), ('order_cancelled',        'customer', 'push'),
  ('order_cancelled',        'customer', 'email'),
  ('order_cancelled_by_customer', 'shop', 'in_app'), ('order_cancelled_by_customer', 'shop', 'push'),
  ('payment_received',       'customer', 'in_app'),
  ('collection_expired',     'customer', 'push')   -- the in-app question comes from expire_collection_windows()
on conflict do nothing;

-- ---------- 3. Preferences ----------
create table if not exists public.notification_preferences (
  user_id uuid not null references public.profiles(id) on delete cascade,
  channel text not null check (channel in ('in_app', 'push', 'email', 'sms')),
  event_type text not null default '*',
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, channel, event_type)
);
alter table public.notification_preferences enable row level security;
drop policy if exists "notification prefs own read" on public.notification_preferences;
drop policy if exists "notification prefs own insert" on public.notification_preferences;
drop policy if exists "notification prefs own update" on public.notification_preferences;
drop policy if exists "notification prefs own delete" on public.notification_preferences;
create policy "notification prefs own read" on public.notification_preferences for select using (user_id = auth.uid());
create policy "notification prefs own insert" on public.notification_preferences for insert with check (user_id = auth.uid());
create policy "notification prefs own update" on public.notification_preferences for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "notification prefs own delete" on public.notification_preferences for delete using (user_id = auth.uid());
grant select, insert, update, delete on public.notification_preferences to authenticated;

-- On unless the user switched it off. SMS stays off until the user turns it on.
create or replace function public.notification_allowed(p_user uuid, p_channel text, p_event text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select enabled from public.notification_preferences where user_id = p_user and channel = p_channel and event_type = p_event),
    (select enabled from public.notification_preferences where user_id = p_user and channel = p_channel and event_type = '*'),
    p_channel <> 'sms')
$$;
revoke all on function public.notification_allowed(uuid, text, text) from public, anon;
grant execute on function public.notification_allowed(uuid, text, text) to service_role;

-- ---------- 4. Who hears about which order event (edit here) ----------
-- Returns one row per recipient. Messages match what the apps said before.
create or replace function public.order_notification_events(o_old public.orders, o public.orders)
returns table (recipient uuid, audience text, event_type text, notif_type text, title text, message text)
language plpgsql stable security definer set search_path = public as $$
declare
  s public.stores;
  v_student boolean;
  v_shop text;
  v_num text := coalesce(o.order_number, '');
  v_collection boolean := coalesce(o.delivery_location->>'fulfilment', '') = 'collection';
  v_window int;
  v_has_loc boolean;
  v_pickup text;
  v_by_seller boolean;
begin
  select * into s from public.stores where id = o.store_id;
  v_student := coalesce(s.seller_kind, '') = 'student';
  v_shop := coalesce(s.name, 'the shop');

  -- ---- new order ----
  if o_old is null then
    if o.status not in ('received', 'preparing') then return; end if;
    recipient := o.customer_id; audience := 'customer'; event_type := 'order_placed'; notif_type := 'order_received';
    title := 'Order placed';
    message := case
      when v_student then 'Order ' || v_num || ' was sent to ' || v_shop || '. You''ll get a message when they accept it.'
      when o.payment_method = 'card' and o.payment_status = 'paid' then 'Payment successful! Your order ' || v_num || ' has been successfully placed.'
      when o.status = 'preparing' then 'Order ' || v_num || ' received, the kitchen is preparing it now!'
      else 'Order ' || v_num || ' received.' end;
    return next;
    audience := 'shop'; event_type := 'order_new';
    if v_student then
      notif_type := 'seller_order'; title := 'New order';
      message := 'New order ' || v_num || ' from ' || public.first_name_of(o.customer_id) || '.';
      for recipient in select s.manager_id where s.manager_id is not null loop return next; end loop;
    else
      notif_type := 'new_order'; title := 'New order ' || v_num;
      message := 'New order ' || v_num || ' from ' || public.first_name_of(o.customer_id) || ': R' || to_char(coalesce(o.total, 0), 'FM999990.00') || '.';
      for recipient in
        select p.id from public.profiles p
         where p.role in ('manager', 'kitchen') and coalesce(p.active, true)
           and (p.store_id = o.store_id or p.id = s.manager_id)
      loop return next; end loop;
    end if;
    return;
  end if;

  -- ---- status changes ----
  if o.status is distinct from o_old.status then
    recipient := o.customer_id; audience := 'customer';

    if o.status = 'preparing' and o_old.status = 'received' then
      event_type := 'order_preparing'; notif_type := 'preparing'; title := 'Order accepted';
      message := case when v_student then v_shop || ' accepted your order ' || v_num || ' and is preparing it.'
                      else 'The kitchen has started preparing order ' || v_num || '.' end;
      return next;

    elsif o.status = 'ready' and o_old.status in ('received', 'preparing') then
      event_type := 'order_ready'; notif_type := 'ready'; title := 'Your order is ready!';
      if v_student then
        message := 'Your order ' || v_num || ' from ' || v_shop || ' is ready. Show your collection code when you collect it.';
      else
        v_window := public.collection_setting('window');
        v_has_loc := s.address is not null and s.address <> 'Pickup location not yet set. Please update it in Store Settings';
        v_pickup := case when v_has_loc then s.address || ', ' || coalesce(s.campus_location, '') || ' Campus'
                         else 'pickup location, contact the shop for details' end;
        message := case
          when v_collection and coalesce(o.reschedule_count, 0) > 0 and o.rescheduled_for is not null then
            'Your order ' || v_num || ' from ' || v_shop || ' is ready for collection. Please collect it at your new collection time ('
            || public.sa_time(o.rescheduled_for) || '). Your order number remains ' || v_num || '.'
          when v_collection then
            'Your order ' || v_num || ' from ' || v_shop || ' is ready for collection. Please collect your order from the pickup location'
            || case when v_has_loc then ' (' || v_pickup || ')' else '' end
            || '. You have ' || v_window || ' minutes to collect it. After ' || v_window
            || ' minutes, the shop may release your order to someone else. If this happens, you may have to wait up to another 30 minutes while the kitchen prepares your order again.'
          else 'Your order ' || v_num || ' from ' || v_shop || ' is ready for collection at ' || v_pickup || '.' end;
      end if;
      return next;

    elsif o.status in ('collected', 'delivered') then
      event_type := 'order_collected'; notif_type := 'delivered'; title := 'Order collected';
      message := case when v_student then 'Order ' || v_num || ' collected. Enjoy your meal! Tap here to rate it.'
                      when o.status = 'delivered' then 'Order ' || v_num || ' has been delivered. Enjoy your meal!'
                      else 'Order ' || v_num || ' collected. Enjoy your meal!' end;
      return next;

    elsif o.status = 'cancelled' then
      if o.cancel_reason = 'customer_cancelled' then
        -- the customer did it themselves: they get their own confirmation
        -- (payfast-cancel-order / respond_missed_collection); tell the shop
        audience := 'shop'; event_type := 'order_cancelled_by_customer'; notif_type := 'order_cancelled';
        title := 'Order cancelled';
        message := 'Order ' || v_num || ' was cancelled by the customer.'
          || case when o.cancel_note like 'Customer: %' then ' Reason: ' || substr(o.cancel_note, 11) || '.' else '' end;
        for recipient in select s.manager_id where s.manager_id is not null loop return next; end loop;
      else
        event_type := 'order_cancelled'; notif_type := 'order_cancelled'; title := 'Order cancelled';
        v_by_seller := v_student;
        message := 'Sorry, ' || v_shop || ' cancelled your order ' || v_num || '.'
          || case
               when v_by_seller and o.cancel_reason = 'product_unavailable' then ' An item is no longer available.'
               when v_by_seller then coalesce(' ' || nullif(btrim(coalesce(o.cancel_note, '')), ''), '')
               when o.cancel_reason = 'product_unavailable' then ' An item in it is no longer available.'
               when o.cancel_reason = 'restaurant_closed' then ' The shop had to close.'
               else ' ' || coalesce(nullif(btrim(coalesce(o.cancel_note, '')), ''), 'Please contact the shop if you have questions.') end;
        return next;
      end if;
    end if;
    return;
  end if;

  -- ---- cash paid at the counter (before collection) ----
  if o.payment_status = 'paid' and o_old.payment_status is distinct from 'paid' and o.payment_method = 'cod' then
    recipient := o.customer_id; audience := 'customer'; event_type := 'payment_received'; notif_type := 'payment_received';
    title := 'Payment received';
    message := 'Payment of R' || to_char(coalesce(o.total, 0), 'FM999990.00') || ' received for order ' || v_num || '. Thank you!';
    return next;
    return;
  end if;

  -- ---- collection time passed (push only; the in-app question already exists) ----
  if o.collection_state = 'expired' and o_old.collection_state is distinct from 'expired' then
    recipient := o.customer_id; audience := 'customer'; event_type := 'collection_expired'; notif_type := 'collection_expired';
    title := 'Collection time passed';
    message := 'Order ' || v_num || ' wasn''t collected in time. Are you still going to collect it? Open ClickFood to answer.';
    return next;
  end if;
end $$;
revoke all on function public.order_notification_events(public.orders, public.orders) from public, anon, authenticated;

-- ---------- 5. Worker wake-up ----------
create table if not exists public.notification_worker_config (
  id int primary key default 1 check (id = 1),
  function_url text not null,
  secret text not null
);
alter table public.notification_worker_config enable row level security;
revoke all on public.notification_worker_config from anon, authenticated;

-- Calls the notify-worker Edge Function (pg_net sends it after commit).
create or replace function public.kick_notification_worker()
returns void language plpgsql security definer set search_path = public, net as $$
declare c public.notification_worker_config;
begin
  select * into c from public.notification_worker_config where id = 1;
  if not found then return; end if;
  perform net.http_post(
    url := c.function_url, body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-secret', c.secret),
    timeout_milliseconds := 10000);
end $$;
revoke all on function public.kick_notification_worker() from public, anon, authenticated;

-- Cron: only wakes the worker when something is due (retries, stuck jobs).
create or replace function public.kick_notification_worker_if_due()
returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.notification_jobs
              where (status in ('queued', 'failed') and next_attempt_at <= now())
                 or (status = 'processing' and locked_at < now() - interval '5 minutes')) then
    perform public.kick_notification_worker();
  end if;
end $$;
revoke all on function public.kick_notification_worker_if_due() from public, anon, authenticated;

-- ---------- 6. Trigger: order change -> job rows (same transaction) ----------
create or replace function public.queue_order_notifications()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  e record;
  r record;
  v_n int;
  v_any boolean := false;
begin
  begin
    -- how many times the order reached this status (a second "ready"
    -- after preparing again is a new event, a replay is not)
    select count(*) into v_n from jsonb_array_elements(case when jsonb_typeof(new.status_history) = 'array' then new.status_history else '[]'::jsonb end) h
     where h->>'status' = new.status;
    for e in select * from public.order_notification_events(case when tg_op = 'INSERT' then null else old end, new) loop
      continue when e.recipient is null;
      for r in select channel from public.notification_channel_rules
                where event_type = e.event_type and audience = e.audience and enabled loop
        insert into public.notification_jobs (recipient_id, channel, event_type, payload, dedupe_key)
        values (e.recipient, r.channel, e.event_type,
                jsonb_build_object('order_id', new.id, 'order_number', new.order_number, 'order_status', new.status,
                                   'store_id', new.store_id, 'type', e.notif_type, 'title', e.title, 'message', e.message,
                                   'audience', e.audience),
                'order:' || new.id || ':' || e.event_type || ':' || greatest(v_n, 1) || ':' || r.channel || ':user:' || e.recipient)
        on conflict (dedupe_key) do nothing;
        if found then v_any := true; end if;
      end loop;
    end loop;
  exception when others then
    -- never block the order itself; keep the error for review
    insert into public.notification_errors (order_id, error) values (new.id, sqlstate || ': ' || sqlerrm);
    v_any := false;
  end;
  if v_any then
    begin perform public.kick_notification_worker();
    exception when others then null; -- the cron run picks the jobs up anyway
    end;
  end if;
  return null;
end $$;
drop trigger if exists trg_zz_queue_order_notifications on public.orders;
create trigger trg_zz_queue_order_notifications
  after insert or update of status, payment_status, collection_state on public.orders
  for each row execute function public.queue_order_notifications();

-- ---------- 7. Claim / finish (used by the worker, service role only) ----------
-- Claims due jobs for one channel (FOR UPDATE SKIP LOCKED, so two workers
-- never take the same job). Jobs the user switched off, or whose order has
-- moved on (e.g. a cancel that was undone) or is gone, are marked skipped.
create or replace function public.claim_notification_jobs(p_channel text, p_limit int default 25)
returns setof public.notification_jobs language plpgsql security definer set search_path = public as $$
begin
  update public.notification_jobs j set status = 'skipped', error = 'Turned off by the user', locked_at = null
   where j.id in (
     select id from public.notification_jobs
      where channel = p_channel and status in ('queued', 'failed') and next_attempt_at <= now()
        and not public.notification_allowed(recipient_id, channel, event_type)
      for update skip locked);

  update public.notification_jobs j set status = 'skipped', error = 'Order changed before sending', locked_at = null
   where j.id in (
     select nj.id from public.notification_jobs nj
       join public.orders o on o.id = (nj.payload->>'order_id')::uuid
      where nj.channel = p_channel and nj.status in ('queued', 'failed') and nj.next_attempt_at <= now()
        and nj.event_type in ('order_cancelled_by_customer', 'order_cancelled', 'collection_expired')
        and o.status is distinct from nj.payload->>'order_status'
      for update of nj skip locked);

  update public.notification_jobs j set status = 'skipped', error = 'Order no longer exists', locked_at = null
   where j.id in (
     select nj.id from public.notification_jobs nj
      where nj.channel = p_channel and nj.status in ('queued', 'failed') and nj.next_attempt_at <= now()
        and nj.payload ? 'order_id'
        and not exists (select 1 from public.orders o where o.id = (nj.payload->>'order_id')::uuid)
      for update of nj skip locked);

  return query
  update public.notification_jobs j
     set status = 'processing', locked_at = now(), attempts = j.attempts + 1
   where j.id in (
     select id from public.notification_jobs
      where channel = p_channel
        and ((status in ('queued', 'failed') and next_attempt_at <= now())
             or (status = 'processing' and locked_at < now() - interval '5 minutes'))
      order by created_at
      limit greatest(1, least(coalesce(p_limit, 25), 200))
      for update skip locked)
  returning j.*;
end $$;

-- Backoff after a failure: 30 s, 2 min, 10 min, 30 min; the 5th failure is dead.
create or replace function public.finish_notification_job(p_id uuid, p_ok boolean, p_provider_id text default null,
                                                           p_error text default null, p_skip boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare j public.notification_jobs;
begin
  select * into j from public.notification_jobs where id = p_id for update;
  if not found then return; end if;
  if p_skip then
    update public.notification_jobs set status = 'skipped', error = left(p_error, 500), locked_at = null where id = p_id;
  elsif p_ok then
    update public.notification_jobs set status = 'sent', sent_at = now(), provider_message_id = p_provider_id,
           error = null, locked_at = null where id = p_id;
  elsif j.attempts >= 5 then
    update public.notification_jobs set status = 'dead', failed_at = now(), error = left(p_error, 500), locked_at = null where id = p_id;
  else
    update public.notification_jobs set status = 'failed', failed_at = now(), error = left(p_error, 500), locked_at = null,
           next_attempt_at = now() + case j.attempts when 1 then interval '30 seconds' when 2 then interval '2 minutes'
                                                     when 3 then interval '10 minutes' else interval '30 minutes' end
     where id = p_id;
  end if;
end $$;

-- A push that can't reach any device: for important events, fall back to email.
create or replace function public.queue_notification_fallback(p_job uuid, p_channel text)
returns void language plpgsql security definer set search_path = public as $$
declare j public.notification_jobs;
begin
  select * into j from public.notification_jobs where id = p_job;
  if not found or j.event_type not in ('order_ready', 'order_cancelled') then return; end if;
  insert into public.notification_jobs (recipient_id, channel, event_type, payload, dedupe_key)
  values (j.recipient_id, p_channel, j.event_type, j.payload || jsonb_build_object('fallback_from', j.id),
          j.dedupe_key || ':fallback:' || p_channel)
  on conflict (dedupe_key) do nothing;
end $$;

revoke all on function public.claim_notification_jobs(text, int) from public, anon, authenticated;
revoke all on function public.finish_notification_job(uuid, boolean, text, text, boolean) from public, anon, authenticated;
revoke all on function public.queue_notification_fallback(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_notification_jobs(text, int) to service_role;
grant execute on function public.finish_notification_job(uuid, boolean, text, text, boolean) to service_role;
grant execute on function public.queue_notification_fallback(uuid, text) to service_role;
grant execute on function public.queue_email(text, text, uuid, uuid, text, text, jsonb) to service_role;

-- ---------- 8. Delivery status ----------
-- The app calls this when an in-app notification reaches the screen.
create or replace function public.mark_notifications_delivered(p_ids uuid[])
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then return 0; end if;
  update public.notification_jobs set status = 'delivered', delivered_at = now()
   where channel = 'in_app' and status = 'sent' and recipient_id = auth.uid()
     and provider_message_id = any (select x::text from unnest(coalesce(p_ids, '{}')) x);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.mark_notifications_delivered(uuid[]) from public, anon;
grant execute on function public.mark_notifications_delivered(uuid[]) to authenticated;

-- Email jobs hand over to the existing email_outbox (Resend); its status
-- (delivered, or bounced / failed = dead) flows back to the job.
create or replace function public.sync_email_job_status()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status and new.status in ('delivered', 'bounced', 'failed') then
    update public.notification_jobs
       -- a final email failure ends the job: email_outbox does its own retries
       set status = case when new.status = 'delivered' then 'delivered' else 'dead' end,
           delivered_at = case when new.status = 'delivered' then now() else delivered_at end,
           failed_at = case when new.status = 'delivered' then failed_at else now() end,
           error = case when new.status = 'delivered' then error else coalesce(new.error, 'Email ' || new.status) end
     where channel = 'email' and provider_message_id = 'email_outbox:' || new.id and status in ('sent', 'processing', 'dead');
  end if;
  return new;
end $$;
drop trigger if exists trg_sync_email_job_status on public.email_outbox;
create trigger trg_sync_email_job_status after update of status on public.email_outbox
  for each row execute function public.sync_email_job_status();

-- ---------- 9. Who may write notifications directly ----------
-- Before: any user could write a notification with any text to themselves,
-- and shop staff to any of their customers. Now only the developer
-- (shop notices from the developer app); everything else comes from the
-- server (definer functions, the worker).
drop policy if exists "notif insert allowed" on public.notifications;
create policy "notif insert allowed" on public.notifications for insert
  with check (public."current_role"() = 'developer');

-- The in-app row the worker wrote for a job (so a retried job never shows twice).
alter table public.notifications add column if not exists job_id uuid;
create unique index if not exists notifications_job_id on public.notifications (job_id);

-- ---------- 10. Push devices: own rows only (unchanged) + invalid marker ----------
alter table public.push_subscriptions add column if not exists invalid_at timestamptz;

-- ---------- 11. Cron: every 15 seconds, only calls the worker when jobs are due ----------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'notification-worker';
    perform cron.schedule('notification-worker', '15 seconds', 'select public.kick_notification_worker_if_due()');
    -- finished jobs are only bookkeeping: keep 30 days (failed / dead stay for review)
    perform cron.unschedule(jobid) from cron.job where jobname = 'notification-jobs-cleanup';
    perform cron.schedule('notification-jobs-cleanup', '17 3 * * *',
      $c$delete from public.notification_jobs where status in ('sent', 'delivered', 'skipped') and created_at < now() - interval '30 days'$c$);
  end if;
end $$;

-- ---------- 12. Order functions: their own order notifications move to the queue ----------
-- confirm_collection: same as live, without its order notification insert (now queued by the trigger)
CREATE OR REPLACE FUNCTION public.confirm_collection(p_order_id uuid, p_code text, p_cash_tendered numeric DEFAULT NULL::numeric)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order public.orders;
  v_input text;
begin
  if public.current_role() not in ('manager', 'kitchen') then
    raise exception 'Not authorised to confirm collection.';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  if v_order.store_id is distinct from public.current_store_id() then
    raise exception 'This order does not belong to your store.';
  end if;
  if v_order.status = 'collected' then
    raise exception 'Order has already been collected.';
  end if;
  if v_order.status <> 'ready' then
    raise exception 'Order is not ready for collection yet.';
  end if;

  v_input := upper(trim(coalesce(p_code, '')));
  if v_input = '' or v_order.collection_code is null
     or v_input not in (upper(v_order.collection_code), upper(v_order.collection_token::text)) then
    raise exception 'Invalid collection code.';
  end if;

  if p_cash_tendered is not null and p_cash_tendered < 0 then
    raise exception 'Cash received cannot be negative.';
  end if;

  if v_order.payment_method = 'cod' then
    if p_cash_tendered is null then
      raise exception 'Please enter the exact cash received before confirming collection.';
    end if;
    if abs(p_cash_tendered - v_order.total) > 0.005 then
      raise exception 'Cash received (R%) does not match the order total (R%) — enter the exact amount.',
        trim(to_char(p_cash_tendered, 'FM999999990.00')), trim(to_char(v_order.total, 'FM999999990.00'));
    end if;
  end if;

  update public.orders
    set status = 'collected',
        status_history = coalesce(v_order.status_history, '[]'::jsonb) || jsonb_build_object('status', 'collected', 'at', now()),
        payment_status = 'paid',
        cash_tendered = coalesce(p_cash_tendered, v_order.cash_tendered),
        collected_at = now(),
        collected_by = auth.uid()
    where id = p_order_id
    returning * into v_order;


  return v_order;
end;
$function$;

-- seller_update_order: same as live, without its order notification insert (now queued by the trigger)
CREATE OR REPLACE FUNCTION public.seller_update_order(p_order_id uuid, p_action text, p_reason text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_code text DEFAULT NULL::text)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_store uuid := public.current_seller_store_id();
  o public.orders;
  v_new text;
  v_msg text;
  v_shop text;
  v_code text := upper(btrim(coalesce(p_code, '')));
begin
  if v_store is null then raise exception 'You don''t have a student shop.'; end if;
  select * into o from public.orders where id = p_order_id for update;
  if not found or o.store_id is distinct from v_store then raise exception 'Order not found.'; end if;
  select name into v_shop from public.stores where id = v_store;

  if p_action = 'accept' and o.status = 'received' then
    v_new := 'preparing'; v_msg := v_shop || ' accepted your order ' || o.order_number || ' and is preparing it.';
  elsif p_action = 'ready' and o.status in ('received', 'preparing') then
    v_new := 'ready'; v_msg := 'Your order ' || o.order_number || ' from ' || v_shop || ' is ready. Show your collection code when you collect it.';
  elsif p_action = 'complete' and o.status = 'ready' then
    if v_code = '' then raise exception 'Enter the buyer''s collection code.'; end if;
    if o.collection_code is null or v_code not in (upper(o.collection_code), upper(coalesce(o.collection_token::text, ''))) then
      raise exception 'That code doesn''t match. Ask the buyer for the code on their order.';
    end if;
    v_new := 'collected'; v_msg := 'Order ' || o.order_number || ' collected. Enjoy your meal! Tap here to rate it.';
  elsif p_action = 'cancel' and o.status in ('received', 'preparing', 'ready') then
    if p_reason is null or p_reason not in ('product_unavailable', 'kitchen_cancelled', 'other') then
      raise exception 'Please choose a reason.';
    end if;
    v_new := 'cancelled';
    v_msg := 'Sorry, ' || v_shop || ' cancelled your order ' || o.order_number || '.'
      || case when p_reason = 'product_unavailable' then ' An item is no longer available.'
              when nullif(btrim(coalesce(p_note, '')), '') is not null then ' ' || left(btrim(p_note), 200)
              else '' end;
  else
    raise exception 'This order can''t be changed like that any more.';
  end if;

  update public.orders set
    status = v_new,
    collected_at = case when v_new = 'collected' then now() else collected_at end,
    collected_by = case when v_new = 'collected' then auth.uid() else collected_by end,
    cancel_reason = case when v_new = 'cancelled' then p_reason else cancel_reason end,
    cancel_note = case when v_new = 'cancelled' then nullif(left(btrim(coalesce(p_note, '')), 200), '') else cancel_note end,
    status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object('status', v_new, 'at', now(), 'by', 'seller')
   where id = o.id returning * into o;
  return o;
end $function$;

-- staff_cancel_order: same as live, without its order notification insert (now queued by the trigger)
CREATE OR REPLACE FUNCTION public.staff_cancel_order(p_order_id uuid, p_reason text, p_note text DEFAULT NULL::text)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order public.orders;
  v_role text := public.current_role();
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  if v_role not in ('manager', 'kitchen') or v_order.store_id is distinct from public.current_store_id() then
    raise exception 'Only this shop''s staff can cancel its orders.';
  end if;
  if v_order.status not in ('received', 'preparing', 'ready') then
    raise exception 'This order can no longer be cancelled.';
  end if;
  if v_order.payment_method = 'card' and v_order.payment_status = 'paid' then
    raise exception 'This order was paid by card. Refund it from Refunds instead of cancelling it here.';
  end if;
  if p_reason is null or p_reason not in ('kitchen_cancelled', 'product_unavailable', 'payment_problem', 'restaurant_closed', 'other') then
    raise exception 'Please choose a reason.';
  end if;
  update public.orders
     set status = 'cancelled', cancel_reason = p_reason, cancel_note = nullif(left(trim(coalesce(p_note, '')), 200), ''),
         status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('status', 'cancelled', 'at', now()))
   where id = p_order_id returning * into v_order;
  return v_order;
end $function$;

-- finalize_paystack_checkout: same as live, without its order notification insert (now queued by the trigger)
CREATE OR REPLACE FUNCTION public.finalize_paystack_checkout(p_reference text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_session public.checkout_sessions;
  v_group jsonb;
  v_order public.orders;
  v_order_ids jsonb := '[]'::jsonb;
begin
  select * into v_session from public.checkout_sessions where reference = p_reference for update;
  if not found then
    raise exception 'Unknown checkout session.';
  end if;

  if v_session.group_id is not null then
    return public.finalize_group_share(p_reference);
  end if;

  if v_session.status = 'paid' then
    return jsonb_build_object('order_ids', v_session.order_ids);
  end if;

  for v_group in select * from jsonb_array_elements(v_session.groups)
  loop
    insert into public.orders (
      customer_id, store_id, items, subtotal, delivery_fee, discount, promo_code, total,
      payment_method, payment_status, payment_reference, delivery_location, status, status_history,
      paystack_subaccount_code, payout_amount, platform_fee_amount
    ) values (
      v_session.customer_id,
      (v_group->>'storeId')::uuid,
      v_group->'items',
      (v_group->>'subtotal')::numeric,
      0,
      coalesce((v_group->>'discount')::numeric, 0),
      v_group->>'promoCode',
      (v_group->>'total')::numeric,
      'card',
      'paid',
      p_reference,
      v_group->'deliveryLocation',
      'preparing',
      jsonb_build_array(jsonb_build_object('status', 'received', 'at', now()), jsonb_build_object('status', 'preparing', 'at', now())),
      v_group->>'subaccountCode',
      (v_group->>'shopAmount')::numeric,
      coalesce((v_group->>'platformFeeAmount')::numeric, 0)
    )
    returning * into v_order;

    v_order_ids := v_order_ids || to_jsonb(v_order.id);
  end loop;

  update public.checkout_sessions
    set status = 'paid', order_ids = v_order_ids, updated_at = now()
    where reference = p_reference;

  return jsonb_build_object('order_ids', v_order_ids);
end;
$function$;

-- New student order: the seller is now told by the queue (order_new).
drop trigger if exists trg_notify_student_seller on public.orders;

-- Rollback: supabase/notification_queue_rollback.sql
