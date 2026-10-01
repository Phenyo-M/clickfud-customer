-- ============================================================
-- NEW (2026-09-29) — MISSED COLLECTION / RESCHEDULE COLLECTION
--
-- One order, one order number, start to finish. Nothing here creates an
-- order, a payment, or a charge: every step updates the SAME orders row.
--
-- Flow for a collection order (delivery orders are unaffected):
--   ready ─(window: ready_at + collection_window_minutes)─┐
--     collected by staff at any point → status 'collected' (ends everything)
--     window passes, no collection → collection_state 'expired',
--       customer asked "Are you still going to collect?" (one notification)
--       ├ "Yes" + new time → same order, collection_state 'rescheduled'
--       │    food still there → stays 'ready', new deadline = new time + window
--       │    food released    → back to 'preparing' (needs_reprep) — kitchen
--       │                        makes it again, marks it ready as usual
--       ├ "No"               → 'cancelled' (collection_state 'declined'),
--       │                        existing rules: a ready order is never
--       │                        refunded by cancelling; payment untouched
--       └ no answer within collection_response_minutes → 'uncollected'
--     rescheduled deadline passes: another expiry if reschedules remain
--     (max_collection_reschedules), otherwise status 'uncollected'.
--   'uncollected' = closed: off the kitchen board and the customer's active
--   orders, cannot be rescheduled; the row (payment, history) is kept.
--
-- Staff: 'released' (gave it away after the window) and 'reprepare' (make
-- it again — e.g. the customer walked in after it was released) via
-- staff_collection_action(). confirm_collection() is unchanged and still
-- works for any 'ready' order — it simply ends the whole workflow.
--
-- The clock runs on the SERVER: pg_cron calls expire_collection_windows()
-- every minute, so it works with the customer's app closed or offline.
-- Safe to run more than once.
-- ============================================================

-- 1. Settings (one row, id = 1)
alter table public.platform_config add column if not exists collection_window_minutes int not null default 30;
alter table public.platform_config add column if not exists max_collection_reschedules int not null default 2;
alter table public.platform_config add column if not exists collection_response_minutes int not null default 60;

-- 2. New final status
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status = any (array['received','preparing','ready','out_for_delivery','delivered','collected','cancelled','uncollected']));

-- 3. Collection tracking on the order itself
alter table public.orders add column if not exists ready_at timestamptz;
alter table public.orders add column if not exists original_ready_at timestamptz;
alter table public.orders add column if not exists collection_deadline timestamptz;
alter table public.orders add column if not exists original_collection_deadline timestamptz;
alter table public.orders add column if not exists collection_state text;
alter table public.orders add column if not exists collection_expired_at timestamptz;
alter table public.orders add column if not exists collection_response_deadline timestamptz;
alter table public.orders add column if not exists rescheduled_for timestamptz;
alter table public.orders add column if not exists rescheduled_at timestamptz;
alter table public.orders add column if not exists reschedule_reason text;
alter table public.orders add column if not exists reschedule_count int not null default 0;
alter table public.orders add column if not exists released_at timestamptz;
alter table public.orders add column if not exists needs_reprep boolean not null default false;
alter table public.orders drop constraint if exists orders_collection_state_check;
alter table public.orders add constraint orders_collection_state_check
  check (collection_state is null or collection_state = any (array['window','expired','rescheduled','reprep','declined','uncollected','collected']));
create index if not exists orders_collection_due_idx on public.orders (collection_deadline) where status = 'ready';

create or replace function public.collection_setting(p_name text)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select case p_name
    when 'window'   then coalesce((select collection_window_minutes   from public.platform_config where id = 1), 30)
    when 'max'      then coalesce((select max_collection_reschedules  from public.platform_config where id = 1), 2)
    when 'response' then coalesce((select collection_response_minutes from public.platform_config where id = 1), 60)
  end
$$;

-- "13:00" in South African time, for notification text.
create or replace function public.sa_time(p_at timestamptz)
returns text
language sql
immutable
as $$ select to_char(p_at at time zone 'Africa/Johannesburg', 'HH24:MI') $$;

-- 4. Real ready timestamp + deadline, set by the server whenever a
--    collection order becomes ready (first time, or again after re-making).
create or replace function public.track_collection_window()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deadline timestamptz;
begin
  if coalesce(new.delivery_location->>'fulfilment', '') <> 'collection' then
    return new;
  end if;
  if new.status = 'ready' and old.status is distinct from 'ready' then
    v_deadline := greatest(now(), coalesce(new.rescheduled_for, now()))
                  + make_interval(mins => public.collection_setting('window'));
    new.ready_at := now();
    new.original_ready_at := coalesce(old.original_ready_at, now());
    new.collection_deadline := v_deadline;
    new.original_collection_deadline := coalesce(old.original_collection_deadline, v_deadline);
    new.collection_state := case when coalesce(new.reschedule_count, 0) > 0 then 'rescheduled' else 'window' end;
    new.collection_response_deadline := null;
    new.needs_reprep := false;
    new.released_at := null; -- freshly made: this food is here
  end if;
  if new.status = 'collected' and old.status is distinct from 'collected' then
    new.collection_state := 'collected';
    new.collection_response_deadline := null;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_track_collection_window on public.orders;
create trigger trg_track_collection_window
  before update on public.orders
  for each row execute function public.track_collection_window();

-- 5. The clock (runs every minute from pg_cron).
create or replace function public.expire_collection_windows()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders;
  v_max int := public.collection_setting('max');
  v_resp int := public.collection_setting('response');
  n int := 0;
begin
  -- a) collection time passed, not collected
  for o in
    select * from public.orders
     where status = 'ready' and collection_state in ('window', 'rescheduled')
       and collection_deadline < now()
     for update skip locked
  loop
    if o.reschedule_count >= v_max then
      update public.orders set
        status = 'uncollected', collection_state = 'uncollected', collection_expired_at = now(),
        collection_response_deadline = null,
        status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object('status', 'uncollected', 'at', now())
       where id = o.id;
      insert into public.notifications (user_id, message, type) values (o.customer_id,
        'Your collection time for order ' || o.order_number || ' has passed and the order was not collected, so it has been closed.', 'order_uncollected');
    else
      update public.orders set
        collection_state = 'expired', collection_expired_at = now(),
        collection_response_deadline = now() + make_interval(mins => v_resp),
        status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object('status', 'collection_expired', 'at', now())
       where id = o.id;
      insert into public.notifications (user_id, message, type) values (o.customer_id,
        case when o.reschedule_count > 0
          then 'Your new collection time (' || public.sa_time(o.rescheduled_for) || ') for order ' || o.order_number || ' has passed, and your order has not been collected. Are you still going to collect your order?'
          else 'Your ' || public.collection_setting('window') || '-minute collection period for order ' || o.order_number || ' has passed, and your order has not been collected. Are you still going to collect your order?'
        end, 'collection_expired');
    end if;
    n := n + 1;
  end loop;

  -- b) asked, but no answer in time
  for o in
    select * from public.orders
     where status = 'ready' and collection_state = 'expired'
       and collection_response_deadline < now()
     for update skip locked
  loop
    update public.orders set
      status = 'uncollected', collection_state = 'uncollected', collection_response_deadline = null,
      status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object('status', 'uncollected', 'at', now())
     where id = o.id;
    insert into public.notifications (user_id, message, type) values (o.customer_id,
      'Order ' || o.order_number || ' was not collected and we did not hear back from you, so it has been closed.', 'order_uncollected');
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.expire_collection_windows() from public, anon, authenticated;

-- 6. Customer: "Yes, I'll still collect" (+ new time, optional reason) or "No".
create or replace function public.respond_missed_collection(p_order_id uuid, p_will_collect boolean, p_new_time timestamptz default null, p_reason text default null)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders;
  v_reason text := nullif(btrim(left(coalesce(p_reason, ''), 300)), '');
  v_window int := public.collection_setting('window');
  v_reprep boolean;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found or o.customer_id is distinct from auth.uid() then
    raise exception 'Order not found.';
  end if;
  if o.status = 'collected' then
    raise exception 'This order has already been collected.';
  end if;
  if o.status in ('uncollected', 'cancelled') then
    raise exception 'This order has expired and can no longer be rescheduled.';
  end if;
  if o.status <> 'ready' or o.collection_state is distinct from 'expired' then
    raise exception 'This order is not waiting for a new collection time.';
  end if;

  if not p_will_collect then
    update public.orders set
      status = 'cancelled', collection_state = 'declined', collection_response_deadline = null,
      status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object('status', 'cancelled', 'at', now(), 'reason', 'customer_will_not_collect')
     where id = o.id returning * into o;
    insert into public.notifications (user_id, message, type) values (o.customer_id,
      'Order ' || o.order_number || ' has been cancelled because you won''t be collecting it.', 'order_cancelled');
    return o;
  end if;

  if o.reschedule_count >= public.collection_setting('max') then
    raise exception 'This order cannot be rescheduled again.';
  end if;
  if p_new_time is null or p_new_time < now() - interval '2 minutes' or p_new_time > now() + interval '6 hours' then
    raise exception 'Please choose a collection time within the next 6 hours.';
  end if;

  v_reprep := o.released_at is not null;
  update public.orders set
    rescheduled_for = p_new_time,
    rescheduled_at = now(),
    reschedule_reason = v_reason,
    reschedule_count = o.reschedule_count + 1,
    collection_response_deadline = null,
    collection_state = 'rescheduled',
    status = case when v_reprep then 'preparing' else 'ready' end,
    needs_reprep = v_reprep,
    collection_deadline = case when v_reprep then null else greatest(p_new_time, now()) + make_interval(mins => v_window) end,
    status_history = coalesce(status_history, '[]'::jsonb)
      || jsonb_build_object('status', 'rescheduled', 'at', now(), 'for', p_new_time)
      || case when v_reprep then jsonb_build_array(jsonb_build_object('status', 'preparing', 'at', now(), 'reason', 'prepare_again')) else '[]'::jsonb end
   where id = o.id returning * into o;
  insert into public.notifications (user_id, message, type) values (o.customer_id,
    'Your collection has been rescheduled for ' || public.sa_time(p_new_time) || '. Your order number remains ' || o.order_number || '.'
    || case when v_reprep then ' Your order will be prepared again for your new collection time.' else '' end,
    'order_rescheduled');
  return o;
end;
$$;
revoke all on function public.respond_missed_collection(uuid, boolean, timestamptz, text) from public, anon;
grant execute on function public.respond_missed_collection(uuid, boolean, timestamptz, text) to authenticated;

-- 7. Staff: 'released' (gave the food away after the window passed) and
--    'reprepare' (make it again — customer is back / rescheduled).
create or replace function public.staff_collection_action(p_order_id uuid, p_action text)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders;
begin
  if public.current_role() not in ('manager', 'kitchen') then
    raise exception 'Not authorised.';
  end if;
  select * into o from public.orders where id = p_order_id for update;
  if not found or o.store_id is distinct from public.current_store_id() then
    raise exception 'Order not found.';
  end if;
  if o.status <> 'ready' or coalesce(o.delivery_location->>'fulfilment', '') <> 'collection' then
    raise exception 'Only a ready collection order can be changed here.';
  end if;

  if p_action = 'released' then
    if o.released_at is not null then return o; end if;
    if o.collection_deadline is null or o.collection_deadline > now() then
      raise exception 'The collection window has not passed yet.';
    end if;
    update public.orders set
      released_at = now(),
      status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object('status', 'released', 'at', now())
     where id = o.id returning * into o;
    return o;
  elsif p_action = 'reprepare' then
    update public.orders set
      status = 'preparing', needs_reprep = true, released_at = coalesce(released_at, now()),
      collection_state = case when collection_state = 'rescheduled' then 'rescheduled' else 'reprep' end,
      collection_response_deadline = null, collection_deadline = null,
      status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object('status', 'preparing', 'at', now(), 'reason', 'prepare_again')
     where id = o.id returning * into o;
    insert into public.notifications (user_id, message, type) values (o.customer_id,
      'Your order ' || o.order_number || ' will be prepared again. We''ll let you know when it''s ready.', 'preparing');
    return o;
  end if;
  raise exception 'Unknown action.';
end;
$$;
revoke all on function public.staff_collection_action(uuid, text) from public, anon;
grant execute on function public.staff_collection_action(uuid, text) to authenticated;

-- 8. Existing ready collection orders: fill in their real ready time.
--    Ones already past their window are marked expired WITHOUT sending
--    notifications now (the app shows them the question when opened).
update public.orders o set
  ready_at = h.at, original_ready_at = h.at,
  collection_deadline = h.at + make_interval(mins => public.collection_setting('window')),
  original_collection_deadline = h.at + make_interval(mins => public.collection_setting('window')),
  collection_state = case when h.at + make_interval(mins => public.collection_setting('window')) < now() then 'expired' else 'window' end,
  collection_expired_at = case when h.at + make_interval(mins => public.collection_setting('window')) < now() then now() end,
  collection_response_deadline = case when h.at + make_interval(mins => public.collection_setting('window')) < now()
    then now() + make_interval(mins => public.collection_setting('response')) end
from (
  select id, (select (e->>'at')::timestamptz from jsonb_array_elements(status_history) e
               where e->>'status' = 'ready' order by (e->>'at')::timestamptz desc limit 1) as at
    from public.orders
   where status = 'ready' and coalesce(delivery_location->>'fulfilment', '') = 'collection' and collection_state is null
) h
where o.id = h.id and h.at is not null;

-- 9. Schedule the clock (every minute).
do $$ begin
  if exists (select 1 from cron.job where jobname = 'expire-collection-windows') then
    perform cron.unschedule('expire-collection-windows');
  end if;
  perform cron.schedule('expire-collection-windows', '* * * * *', 'select public.expire_collection_windows()');
end $$;
