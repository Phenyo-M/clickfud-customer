-- =========================================================================
-- ClickFood — Phase 5b: login history + fuller audit log (2026-10-01)
-- Run LAST (after inventory_ingredients.sql).
--
--  * login_events — when a staff/developer account signed in, which app,
--    a short device description ("Chrome on Android") and whether the
--    two-step code was used. No IP address, no location, no tokens.
--  * audit_log gets store_id (filled automatically) so each manager can read
--    their own shop's log; the developer still reads everything.
--  * The database itself now records (so nothing can skip it):
--      product created / deleted, price changes (R35 -> R38), product
--      changes, sold out / available again, staff account changes
--      (role, shop, active), shop settings (hours, temporary closure,
--      name, address, prep time).
--    Passwords, tokens and payment secrets are never written to it.
-- Safe to run more than once.
-- =========================================================================

-- ---------- Login history ----------
create table if not exists public.login_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  store_id uuid references public.stores (id) on delete set null,
  role text,
  app text check (app in ('staff', 'developer', 'customer')),
  device text check (device is null or char_length(device) <= 80),
  two_step boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists login_events_user_idx on public.login_events (user_id, created_at desc);
create index if not exists login_events_store_idx on public.login_events (store_id, created_at desc);
alter table public.login_events enable row level security;
drop policy if exists "logins: own" on public.login_events;
create policy "logins: own" on public.login_events for select using (user_id = auth.uid());
drop policy if exists "logins: manager sees shop staff" on public.login_events;
create policy "logins: manager sees shop staff" on public.login_events for select
  using (public.current_role() = 'manager' and store_id = public.current_store_id());
drop policy if exists "logins: developer sees all" on public.login_events;
create policy "logins: developer sees all" on public.login_events for select using (public.current_role() = 'developer');

-- Called by the app right after a sign-in (and again after the two-step code).
create or replace function public.record_login(p_app text, p_device text)
returns void language plpgsql security definer set search_path = public as $$
declare p public.profiles; v_two boolean := coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2';
begin
  if auth.uid() is null then return; end if;
  select * into p from public.profiles where id = auth.uid();
  if not found or p.role = 'customer' then return; end if;      -- staff and developer only
  -- one row per sign-in: ignore repeats within 2 minutes unless it's the code step
  if exists (select 1 from public.login_events where user_id = auth.uid() and created_at > now() - interval '2 minutes' and two_step = v_two) then return; end if;
  insert into public.login_events (user_id, store_id, role, app, device, two_step)
  values (auth.uid(), p.store_id, p.role, case when p_app in ('staff', 'developer', 'customer') then p_app end,
          left(regexp_replace(coalesce(p_device, ''), '[^A-Za-z0-9 .,()/-]', '', 'g'), 80), v_two);
end $$;
revoke all on function public.record_login(text, text) from public, anon;
grant execute on function public.record_login(text, text) to authenticated;

-- ---------- Audit log: per shop ----------
alter table public.audit_log add column if not exists store_id uuid references public.stores (id) on delete set null;
create index if not exists audit_log_store_idx on public.audit_log (store_id, created_at desc);

create or replace function public.fill_audit_store()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.store_id is null and new.target_id is not null then
    new.store_id := case new.target_type
      when 'store' then (select id from public.stores where id = new.target_id)
      when 'menu_item' then (select store_id from public.menu_items where id = new.target_id)
      when 'ingredient' then (select store_id from public.ingredients where id = new.target_id)
      when 'refund' then (select store_id from public.refund_requests where id = new.target_id)
      when 'staff' then (select store_id from public.profiles where id = new.target_id)
      else null end;
  end if;
  if new.actor_name is null and new.actor_id is not null then
    new.actor_name := (select coalesce(name, email) from public.profiles where id = new.actor_id);
  end if;
  return new;
end $$;
drop trigger if exists trg_fill_audit_store on public.audit_log;
create trigger trg_fill_audit_store before insert on public.audit_log for each row execute function public.fill_audit_store();

drop policy if exists "audit_log manager reads own shop" on public.audit_log;
create policy "audit_log manager reads own shop" on public.audit_log for select
  using (public.current_role() = 'manager' and store_id = public.current_store_id());

create or replace function public.audit(p_action text, p_type text, p_target uuid, p_name text, p_detail text, p_store uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (actor_id, actor_name, action, target_type, target_id, target_name, reason, store_id)
  values (auth.uid(), coalesce((select coalesce(name, email) from public.profiles where id = auth.uid()), 'system'),
          p_action, p_type, p_target, p_name, left(p_detail, 300), p_store);
end $$;
revoke all on function public.audit(text, text, uuid, text, text, uuid) from public, anon, authenticated;

-- Products
create or replace function public.audit_menu_items()
returns trigger language plpgsql security definer set search_path = public as $$
declare d text[] := '{}';
begin
  if tg_op = 'INSERT' then
    perform public.audit('product_created', 'menu_item', new.id, new.name, 'R' || to_char(new.price, 'FM999990.00'), new.store_id);
  elsif tg_op = 'DELETE' then
    perform public.audit('product_deleted', 'menu_item', old.id, old.name, null, old.store_id);
    return old;
  else
    if new.price is distinct from old.price then
      perform public.audit('price_changed', 'menu_item', new.id, new.name,
        'R' || to_char(old.price, 'FM999990.00') || ' -> R' || to_char(new.price, 'FM999990.00'), new.store_id);
    end if;
    if new.available is distinct from old.available then
      perform public.audit(case when new.available then 'mark_available' else 'mark_sold_out' end, 'menu_item', new.id, new.name,
                           public.current_role(), new.store_id);
    end if;
    if new.name is distinct from old.name then d := d || ('name "' || old.name || '" -> "' || new.name || '"'); end if;
    if new.description is distinct from old.description then d := d || 'description'::text; end if;
    if new.image is distinct from old.image then d := d || 'photo'::text; end if;
    if new.category is distinct from old.category then d := d || ('category ' || coalesce(old.category, '') || ' -> ' || coalesce(new.category, '')); end if;
    if new.availability_windows is distinct from old.availability_windows then d := d || 'time of day'::text; end if;
    if new.status is distinct from old.status then d := d || ('approval ' || coalesce(old.status, '') || ' -> ' || coalesce(new.status, '')); end if;
    if cardinality(d) > 0 then
      perform public.audit('product_changed', 'menu_item', new.id, new.name, array_to_string(d, '; '), new.store_id);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_audit_menu_items on public.menu_items;
create trigger trg_audit_menu_items after insert or update or delete on public.menu_items
  for each row execute function public.audit_menu_items();

-- Shop settings (busy toggles and rating counters are deliberately not logged: too frequent / automatic)
create or replace function public.audit_stores()
returns trigger language plpgsql security definer set search_path = public as $$
declare d text[] := '{}';
begin
  if new.store_closed is distinct from old.store_closed then
    perform public.audit(case when new.store_closed then 'shop_closed_temporarily' else 'shop_reopened' end, 'store', new.id, new.name,
                         case when new.store_closed then coalesce(new.closure_reason, new.closure_category) end, new.id);
  end if;
  if new.weekly_hours is distinct from old.weekly_hours or new.opening_time is distinct from old.opening_time
     or new.closing_time is distinct from old.closing_time or new.closed_days is distinct from old.closed_days then
    d := d || 'opening hours'::text;
  end if;
  if new.name is distinct from old.name then d := d || ('name "' || old.name || '" -> "' || new.name || '"'); end if;
  if new.address is distinct from old.address then d := d || 'address'::text; end if;
  if new.prep_time_min is distinct from old.prep_time_min or new.prep_time_max is distinct from old.prep_time_max then d := d || 'prep time'::text; end if;
  if new.atmosphere_tags is distinct from old.atmosphere_tags then d := d || 'shop features'::text; end if;
  if new.description is distinct from old.description then d := d || 'description'::text; end if;
  if cardinality(d) > 0 then
    perform public.audit('settings_changed', 'store', new.id, new.name, array_to_string(d, '; '), new.id);
  end if;
  return new;
end $$;
drop trigger if exists trg_audit_stores on public.stores;
create trigger trg_audit_stores after update on public.stores for each row execute function public.audit_stores();

-- Staff accounts (role, shop, active). Customers' own profile edits are not logged.
create or replace function public.audit_profiles()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.role is distinct from old.role or new.store_id is distinct from old.store_id or new.active is distinct from old.active)
     and (new.role <> 'customer' or old.role <> 'customer') then
    perform public.audit('staff_changed', 'staff', new.id, coalesce(new.email, new.name),
      concat_ws('; ',
        case when new.role is distinct from old.role then 'role ' || coalesce(old.role, '') || ' -> ' || coalesce(new.role, '') end,
        case when new.active is distinct from old.active then case when new.active then 'reactivated' else 'deactivated' end end,
        case when new.store_id is distinct from old.store_id then 'shop changed' end),
      coalesce(new.store_id, old.store_id));
  end if;
  return new;
end $$;
drop trigger if exists trg_audit_profiles on public.profiles;
create trigger trg_audit_profiles after update on public.profiles for each row execute function public.audit_profiles();

-- set_item_sold_out (ordering_rules.sql) wrote its own audit row; the
-- menu_items trigger above now does that for every route, so make it not
-- double-log. Same signature, same checks.
create or replace function public.set_item_sold_out(p_item_id uuid, p_sold_out boolean)
returns public.menu_items
language plpgsql security definer set search_path = public as $$
declare
  v_item public.menu_items;
  v_role text := public.current_role();
begin
  select * into v_item from public.menu_items where id = p_item_id;
  if not found then raise exception 'Product not found.'; end if;
  if v_role not in ('manager', 'kitchen') or v_item.store_id is distinct from public.current_store_id() then
    raise exception 'You can only change products in your own shop.';
  end if;
  if v_item.available = (not p_sold_out) then return v_item; end if;
  update public.menu_items set available = not p_sold_out where id = p_item_id returning * into v_item;
  return v_item;
end $$;
