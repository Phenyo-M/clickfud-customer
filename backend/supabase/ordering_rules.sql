-- =========================================================================
-- ClickFood — Phase 1: ordering rules (2026-10-01)
--
-- Adds, without dropping or rewriting anything existing:
--   * stores.weekly_hours      — different hours per day (falls back to the
--                                existing opening_time/closing_time/closed_days
--                                while it's null, so current shops keep working)
--   * stores.busy (+ extra minutes) — "Busy": still ordering, longer wait
--   * stores.closure_category  — reason category for a temporary pause
--                                (store_closed + closure_reason already exist)
--   * stores.verified (+ at/by) — only the developer (platform admin) can set
--                                it; every change goes to audit_log
--   * stores.atmosphere_tags   — fixed allow-list (music, study-friendly, …)
--   * menu_items.availability_windows — e.g. breakfast 07:00–11:00 on weekdays
--
-- And server-side enforcement (the app's checks are only for display):
--   * store_status(store_id)          — open / busy / paused / closed, in
--                                       Africa/Johannesburg time
--   * ordering_block_reason(...)      — why an order can't be placed (or null)
--   * trg_enforce_ordering_rules      — refuses customer orders for a paused /
--                                       closed shop or a sold-out / out-of-hours
--                                       item. Card orders are checked BEFORE
--                                       payment (paystack-initialize /
--                                       paystack-charge-saved); the paid order
--                                       itself is created by the server
--                                       (auth.uid() is null) and is never refused
--                                       after the money has been taken.
--   * set_item_sold_out(...)          — managers AND kitchen staff of that shop
--   * set_store_busy(...)             — managers AND kitchen staff of that shop
--
-- Safe to run more than once.
-- =========================================================================

-- ---------- Columns ----------
alter table public.stores add column if not exists weekly_hours jsonb;
alter table public.stores add column if not exists busy boolean not null default false;
alter table public.stores add column if not exists busy_extra_minutes int not null default 15;
alter table public.stores add column if not exists closure_category text;
alter table public.stores add column if not exists verified boolean not null default false;
alter table public.stores add column if not exists verified_at timestamptz;
alter table public.stores add column if not exists verified_by uuid references public.profiles (id) on delete set null;
alter table public.stores add column if not exists atmosphere_tags text[] not null default '{}';
alter table public.menu_items add column if not exists availability_windows jsonb;

-- weekly_hours: {"0": null | {"open":"HH:MM","close":"HH:MM"}, … "6": …}  (0 = Sunday)
create or replace function public.valid_weekly_hours(p jsonb)
returns boolean language plpgsql immutable as $$
declare k text; v jsonb;
begin
  if p is null then return true; end if;
  if jsonb_typeof(p) <> 'object' then return false; end if;
  for k, v in select * from jsonb_each(p) loop
    if k !~ '^[0-6]$' then return false; end if;
    if jsonb_typeof(v) = 'null' then continue; end if;
    if jsonb_typeof(v) <> 'object'
       or coalesce(v->>'open', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or coalesce(v->>'close', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      return false;
    end if;
  end loop;
  return true;
end $$;

-- availability_windows: [{"days":[1,2,3,4,5],"start":"07:00","end":"11:00"}, …]
-- (days optional = every day the shop is open)
create or replace function public.valid_availability_windows(p jsonb)
returns boolean language plpgsql immutable as $$
declare w jsonb; d jsonb;
begin
  if p is null then return true; end if;
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 7 then return false; end if;
  for w in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(w) <> 'object'
       or coalesce(w->>'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or coalesce(w->>'end', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or (w->>'start') >= (w->>'end') then
      return false;
    end if;
    if w ? 'days' then
      if jsonb_typeof(w->'days') <> 'array' then return false; end if;
      for d in select * from jsonb_array_elements(w->'days') loop
        if jsonb_typeof(d) <> 'number' or (d::text)::int not between 0 and 6 then return false; end if;
      end loop;
    end if;
  end loop;
  return true;
end $$;

do $$ begin
  alter table public.stores add constraint stores_weekly_hours_valid check (public.valid_weekly_hours(weekly_hours));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.stores add constraint stores_busy_minutes_range check (busy_extra_minutes between 5 and 120);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.stores add constraint stores_closure_category_valid
    check (closure_category is null or closure_category in ('maintenance', 'staff_shortage', 'ingredients', 'other'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.stores add constraint stores_atmosphere_tags_valid
    check (atmosphere_tags <@ array['music', 'study_friendly', 'group_friendly', 'quick_collection', 'seating']::text[]);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.menu_items add constraint menu_items_windows_valid check (public.valid_availability_windows(availability_windows));
exception when duplicate_object then null; end $$;

-- ---------- Hours / status (South African time) ----------
create or replace function public.store_hours_on(p_store public.stores, p_dow int, out open_t time, out close_t time)
language plpgsql stable as $$
declare d jsonb;
begin
  if p_store.weekly_hours is not null then
    d := p_store.weekly_hours -> p_dow::text;
    if d is null or jsonb_typeof(d) <> 'object' then return; end if;
    open_t := (d->>'open')::time;
    close_t := (d->>'close')::time;
  else
    if p_dow = any (coalesce(p_store.closed_days, '{}')) then return; end if;
    open_t := p_store.opening_time;
    close_t := p_store.closing_time;
  end if;
end $$;

create or replace function public.store_status(p_store_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  s public.stores;
  v_local timestamp := now() at time zone 'Africa/Johannesburg';
  v_dow int := extract(dow from v_local)::int;
  v_t time := v_local::time;
  o time; c time; yo time; yc time;
  v_open boolean := false;
  v_closes time;
begin
  select * into s from public.stores where id = p_store_id;
  if not found then return jsonb_build_object('state', 'closed'); end if;
  if s.store_closed then
    return jsonb_build_object('state', 'paused', 'reason', s.closure_reason, 'category', s.closure_category);
  end if;

  select h.open_t, h.close_t into o, c from public.store_hours_on(s, v_dow) h;
  if o is not null then
    if c > o then v_open := v_t >= o and v_t < c;
    else v_open := v_t >= o;                       -- runs past midnight (or 24h when equal)
    end if;
    v_closes := c;
  end if;
  if not v_open then                               -- still inside last night's late hours?
    select h.open_t, h.close_t into yo, yc from public.store_hours_on(s, (v_dow + 6) % 7) h;
    if yo is not null and yc <= yo and v_t < yc then v_open := true; v_closes := yc; end if;
  end if;

  if not v_open then return jsonb_build_object('state', 'closed'); end if;
  return jsonb_build_object(
    'state', case when s.busy then 'busy' else 'open' end,
    'closes_at', to_char(v_closes, 'HH24:MI'),
    'busy_extra_minutes', s.busy_extra_minutes);
end $$;

create or replace function public.menu_item_window_ok(p_windows jsonb)
returns boolean
language plpgsql stable as $$
declare
  v_local timestamp := now() at time zone 'Africa/Johannesburg';
  v_dow int := extract(dow from v_local)::int;
  v_hm text := to_char(v_local, 'HH24:MI');
  w jsonb;
begin
  if p_windows is null or jsonb_array_length(p_windows) = 0 then return true; end if;
  for w in select * from jsonb_array_elements(p_windows) loop
    if (not (w ? 'days') or w->'days' @> to_jsonb(v_dow))
       and v_hm >= (w->>'start') and v_hm < (w->>'end') then
      return true;
    end if;
  end loop;
  return false;
end $$;

-- Why an order for these items at this shop can't be placed right now (null = it can).
create or replace function public.ordering_block_reason(p_store_id uuid, p_item_ids uuid[])
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_status jsonb := public.store_status(p_store_id);
  v_name text;
  m record;
begin
  select name into v_name from public.stores where id = p_store_id;
  if v_status->>'state' = 'paused' then
    return coalesce(v_name, 'This shop') || ' is temporarily closed'
      || coalesce(' (' || nullif(trim(v_status->>'reason'), '') || ')', '') || ' and isn''t taking new orders.';
  end if;
  if v_status->>'state' = 'closed' then
    return coalesce(v_name, 'This shop') || ' is closed right now. Please order during its opening hours.';
  end if;
  for m in select id, name, available, availability_windows from public.menu_items
           where id = any (coalesce(p_item_ids, '{}')) and store_id = p_store_id loop
    if not m.available then
      return '"' || m.name || '" is sold out right now.';
    end if;
    if not public.menu_item_window_ok(m.availability_windows) then
      return '"' || m.name || '" isn''t available at this time of day.';
    end if;
  end loop;
  return null;
end $$;
revoke all on function public.ordering_block_reason(uuid, uuid[]) from public, anon;
grant execute on function public.ordering_block_reason(uuid, uuid[]) to authenticated, service_role;
grant execute on function public.store_status(uuid) to anon, authenticated, service_role;

-- ---------- Enforcement on every customer-placed order ----------
create or replace function public.enforce_ordering_rules()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_reason text;
  v_ids uuid[];
begin
  -- Server-created orders (a card order finalised after Paystack confirmed
  -- payment, SQL editor) are never refused here: card orders are checked
  -- before payment starts, and money already taken must become an order.
  if auth.uid() is null then return new; end if;
  select array_agg((e->>'menuItemId')::uuid) into v_ids
    from jsonb_array_elements(coalesce(new.items, '[]'::jsonb)) e
    where not coalesce((e->>'isAddon')::boolean, false)
      and (e->>'menuItemId') ~ '^[0-9a-fA-F-]{36}$';
  v_reason := public.ordering_block_reason(new.store_id, v_ids);
  if v_reason is not null then
    raise exception '%', v_reason using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists trg_enforce_ordering_rules on public.orders;
-- Runs before trg_validate_order_pricing (triggers fire in name order).
create trigger trg_enforce_ordering_rules
  before insert on public.orders
  for each row execute function public.enforce_ordering_rules();

-- ---------- Verification: platform admin only, always audited ----------
create or replace function public.protect_store_verification()
returns trigger
language plpgsql security definer set search_path = public as $$
declare v_actor text;
begin
  if new.verified is not distinct from old.verified then
    new.verified_at := old.verified_at;
    new.verified_by := old.verified_by;
    return new;
  end if;
  if auth.uid() is not null and public.current_role() is distinct from 'developer' then
    new.verified := old.verified;            -- a shop can't verify itself
    new.verified_at := old.verified_at;
    new.verified_by := old.verified_by;
    return new;
  end if;
  new.verified_at := case when new.verified then now() else null end;
  new.verified_by := case when new.verified then auth.uid() else null end;
  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  insert into public.audit_log (actor_id, actor_name, action, target_type, target_id, target_name, reason)
  values (auth.uid(), coalesce(v_actor, 'system'), case when new.verified then 'verify' else 'unverify' end,
          'store', new.id, new.name, null);
  return new;
end $$;

drop trigger if exists trg_protect_store_verification on public.stores;
create trigger trg_protect_store_verification
  before update on public.stores
  for each row execute function public.protect_store_verification();

-- ---------- Sold out / busy: managers and kitchen staff of that shop ----------
create or replace function public.set_item_sold_out(p_item_id uuid, p_sold_out boolean)
returns public.menu_items
language plpgsql security definer set search_path = public as $$
declare
  v_item public.menu_items;
  v_role text := public.current_role();
  v_actor text;
begin
  select * into v_item from public.menu_items where id = p_item_id;
  if not found then raise exception 'Product not found.'; end if;
  if v_role not in ('manager', 'kitchen') or v_item.store_id is distinct from public.current_store_id() then
    raise exception 'You can only change products in your own shop.';
  end if;
  if v_item.available = (not p_sold_out) then return v_item; end if;
  update public.menu_items set available = not p_sold_out where id = p_item_id returning * into v_item;
  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  insert into public.audit_log (actor_id, actor_name, action, target_type, target_id, target_name, reason)
  values (auth.uid(), v_actor, case when p_sold_out then 'mark_sold_out' else 'mark_available' end,
          'menu_item', v_item.id, v_item.name, v_role);
  return v_item;
end $$;
revoke all on function public.set_item_sold_out(uuid, boolean) from public, anon;
grant execute on function public.set_item_sold_out(uuid, boolean) to authenticated;

create or replace function public.set_store_busy(p_busy boolean, p_extra_minutes int default null)
returns public.stores
language plpgsql security definer set search_path = public as $$
declare
  v_store public.stores;
  v_role text := public.current_role();
begin
  if v_role not in ('manager', 'kitchen') or public.current_store_id() is null then
    raise exception 'Only your shop''s staff can change this.';
  end if;
  update public.stores
     set busy = p_busy,
         busy_extra_minutes = coalesce(p_extra_minutes, busy_extra_minutes)
   where id = public.current_store_id()
   returning * into v_store;
  return v_store;
end $$;
revoke all on function public.set_store_busy(boolean, int) from public, anon;
grant execute on function public.set_store_busy(boolean, int) to authenticated;
