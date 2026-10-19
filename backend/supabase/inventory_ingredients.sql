-- =========================================================================
-- ClickFood — Phase 4: kitchen inventory (2026-10-01)
--
-- Adds ingredient-level stock NEXT TO the existing per-product stock
-- (menu_items.stock / inventory_movements / suppliers stay exactly as they are).
--
--  * ingredients        — name, unit, quantity, min/max level, supplier, cost per unit
--  * recipe_items       — how much of each ingredient one portion of a product uses
--  * ingredient_batches — deliveries with batch code and expiry date
--  * ingredient_movements — every change (restock, sale, returned, waste, correction)
--  * waste_records      — what was thrown away, why, by whom, estimated cost
--
-- Automatic use: when an order is placed (the same moment product stock already
-- drops: card orders only exist once paid; cash orders are accepted straight
-- away) its products' recipes are subtracted, never below 0. If the order is
-- cancelled before it was ready, the ingredients are put back. Cart additions
-- never touch stock.
--
-- Low stock: when an ingredient drops below its minimum, the shop's managers
-- get one notification (again only after it has been restocked above it).
--
-- Who can do what (enforced here, not just in the app):
--   managers  — everything for their own shop, including costs
--   kitchen   — see ingredient quantities (no costs) and record waste
--   customers — nothing
-- Safe to run more than once.
-- =========================================================================

create table if not exists public.ingredients (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 60),
  unit text not null check (unit in ('kg', 'g', 'l', 'ml', 'each')),
  quantity numeric(12,3) not null default 0 check (quantity >= 0),
  min_level numeric(12,3) not null default 0 check (min_level >= 0),
  max_level numeric(12,3) check (max_level is null or max_level >= 0),
  supplier_id uuid references public.suppliers (id) on delete set null,
  cost_per_unit numeric(10,2) check (cost_per_unit is null or cost_per_unit >= 0),
  active boolean not null default true,
  low_alerted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ingredients_store_name_uniq on public.ingredients (store_id, lower(trim(name)));

create table if not exists public.recipe_items (
  menu_item_id uuid not null references public.menu_items (id) on delete cascade,
  ingredient_id uuid not null references public.ingredients (id) on delete cascade,
  quantity numeric(12,3) not null check (quantity > 0),
  primary key (menu_item_id, ingredient_id)
);

create table if not exists public.ingredient_batches (
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references public.ingredients (id) on delete cascade,
  store_id uuid not null references public.stores (id) on delete cascade,
  batch_code text check (batch_code is null or char_length(batch_code) <= 40),
  quantity numeric(12,3) not null check (quantity > 0),
  expires_on date,
  status text not null default 'active' check (status in ('active', 'used', 'discarded')),
  received_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null
);
create index if not exists ingredient_batches_store_exp_idx on public.ingredient_batches (store_id, expires_on) where status = 'active';

create table if not exists public.waste_records (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete cascade,
  ingredient_id uuid references public.ingredients (id) on delete set null,
  ingredient_name text not null,
  quantity numeric(12,3) not null check (quantity > 0),
  unit text not null,
  estimated_cost numeric(10,2),
  reason text not null check (reason in ('spoiled', 'burned', 'incorrect_preparation', 'customer_cancellation', 'expired', 'other')),
  note text check (note is null or char_length(note) <= 200),
  recorded_by uuid references public.profiles (id) on delete set null,
  recorded_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists waste_records_store_idx on public.waste_records (store_id, created_at desc);

create table if not exists public.ingredient_movements (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete cascade,
  ingredient_id uuid not null references public.ingredients (id) on delete cascade,
  change numeric(12,3) not null,
  balance_after numeric(12,3) not null,
  reason text not null check (reason in ('restock', 'sale', 'returned', 'waste', 'correction')),
  order_id uuid references public.orders (id) on delete set null,
  note text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists ingredient_movements_ing_idx on public.ingredient_movements (ingredient_id, created_at desc);
create index if not exists ingredient_movements_order_idx on public.ingredient_movements (order_id) where order_id is not null;

-- ---------- Access ----------
-- Managers, or a login the manager gave "Ingredients" (staff_permissions.sql).
create or replace function public.is_store_manager(p_store uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_store_perm(p_store, 'manage_inventory')
$$;
create or replace function public.is_store_staff(p_store uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role() in ('manager', 'kitchen') and public.current_store_id() = p_store
$$;

alter table public.ingredients enable row level security;
alter table public.recipe_items enable row level security;
alter table public.ingredient_batches enable row level security;
alter table public.waste_records enable row level security;
alter table public.ingredient_movements enable row level security;
-- Reads: managers see everything for their shop (costs included).
drop policy if exists "ingredients: manager reads" on public.ingredients;
create policy "ingredients: manager reads" on public.ingredients for select using (public.is_store_manager(store_id));
drop policy if exists "recipes: manager reads" on public.recipe_items;
create policy "recipes: manager reads" on public.recipe_items for select
  using (exists (select 1 from public.menu_items m where m.id = menu_item_id and public.is_store_manager(m.store_id)));
drop policy if exists "batches: manager reads" on public.ingredient_batches;
create policy "batches: manager reads" on public.ingredient_batches for select using (public.is_store_manager(store_id));
drop policy if exists "waste: manager reads" on public.waste_records;
create policy "waste: manager reads" on public.waste_records for select using (public.is_store_manager(store_id));
drop policy if exists "movements: manager reads" on public.ingredient_movements;
create policy "movements: manager reads" on public.ingredient_movements for select using (public.is_store_manager(store_id));
-- No insert/update/delete policies at all: every change goes through the
-- functions below, which check the role and write the history.

-- Kitchen view: quantities and expiry, no costs.
create or replace function public.kitchen_ingredients()
returns table (id uuid, name text, unit text, quantity numeric, min_level numeric, low boolean, next_expiry date)
language sql stable security definer set search_path = public as $$
  select i.id, i.name, i.unit, i.quantity, i.min_level, i.quantity < i.min_level,
         (select min(b.expires_on) from public.ingredient_batches b where b.ingredient_id = i.id and b.status = 'active')
  from public.ingredients i
  where i.active and public.is_store_staff(i.store_id)
  order by i.name
$$;

-- ---------- Core: change a quantity + history + low-stock notice ----------
create or replace function public.move_ingredient(p_ingredient uuid, p_change numeric, p_reason text, p_order uuid default null, p_note text default null)
returns numeric
language plpgsql security definer set search_path = public as $$
declare
  v public.ingredients;
  v_new numeric;
  v_applied numeric;
  m record;
begin
  select * into v from public.ingredients where id = p_ingredient for update;
  if not found then return null; end if;
  v_new := greatest(0, v.quantity + p_change);
  v_applied := v_new - v.quantity;
  update public.ingredients set quantity = v_new, updated_at = now(),
         low_alerted = case when v_new >= v.min_level then false else low_alerted end
   where id = p_ingredient;
  if v_applied <> 0 or p_reason <> 'sale' then
    insert into public.ingredient_movements (store_id, ingredient_id, change, balance_after, reason, order_id, note, created_by)
    values (v.store_id, v.id, v_applied, v_new, p_reason, p_order, left(p_note, 200), auth.uid());
  end if;
  -- Crossed below the minimum: tell the shop's managers once.
  if v.min_level > 0 and v_new < v.min_level and not v.low_alerted then
    update public.ingredients set low_alerted = true where id = p_ingredient;
    for m in select id from public.profiles where role = 'manager' and store_id = v.store_id and coalesce(active, true) loop
      insert into public.notifications (user_id, message, type)
      values (m.id, 'Low stock: ' || v.name || ' is at ' || rtrim(to_char(v_new, 'FM999999990.999'), '.') || ' ' || v.unit
              || ' (minimum ' || rtrim(to_char(v.min_level, 'FM999999990.999'), '.') || ' ' || v.unit || ')'
              || coalesce('. Supplier: ' || (select name from public.suppliers s where s.id = v.supplier_id), '') || '.',
              'low_stock');
    end loop;
  end if;
  return v_new;
end $$;
revoke all on function public.move_ingredient(uuid, numeric, text, uuid, text) from public, anon, authenticated;

-- ---------- Automatic use when an order is placed / returned when cancelled ----------
create or replace function public.order_ingredient_usage()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r record;
begin
  if tg_op = 'INSERT' then
    if new.status = 'cancelled' then return new; end if;
    for r in
      select ri.ingredient_id, sum(ri.quantity * greatest(1, coalesce((e->>'qty')::int, 1))) as used
      from jsonb_array_elements(coalesce(new.items, '[]'::jsonb)) e
      join public.recipe_items ri on ri.menu_item_id::text = e->>'menuItemId'
      join public.ingredients i on i.id = ri.ingredient_id and i.store_id = new.store_id
      where not coalesce((e->>'isAddon')::boolean, false)
      group by ri.ingredient_id
    loop
      perform public.move_ingredient(r.ingredient_id, -r.used, 'sale', new.id, null);
    end loop;
  elsif new.status = 'cancelled' and old.status in ('received', 'preparing') then
    -- Not made yet: put back exactly what this order took (once).
    for r in
      select ingredient_id, -sum(change) as back
      from public.ingredient_movements
      where order_id = new.id and reason in ('sale', 'returned')
      group by ingredient_id having sum(change) < 0
    loop
      perform public.move_ingredient(r.ingredient_id, r.back, 'returned', new.id, 'Order cancelled before it was made');
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists trg_order_ingredient_usage on public.orders;
create trigger trg_order_ingredient_usage after insert or update of status on public.orders
  for each row execute function public.order_ingredient_usage();

-- ---------- Manager actions ----------
create or replace function public.audit_inventory(p_action text, p_target uuid, p_name text, p_detail text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (actor_id, actor_name, action, target_type, target_id, target_name, reason)
  values (auth.uid(), (select coalesce(name, email) from public.profiles where id = auth.uid()), p_action, 'ingredient', p_target, p_name, left(p_detail, 300));
end $$;
revoke all on function public.audit_inventory(text, uuid, text, text) from public, anon, authenticated;

create or replace function public.save_ingredient(p_id uuid, p_name text, p_unit text, p_min numeric, p_max numeric, p_supplier uuid, p_cost numeric, p_start_qty numeric default 0)
returns public.ingredients
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.current_store_id();
  v public.ingredients;
  v_old public.ingredients;
begin
  perform public.assert_store_perm(v_store, 'manage_inventory');
  if coalesce(char_length(trim(p_name)), 0) = 0 then raise exception 'Please enter a name.'; end if;
  if p_supplier is not null and not exists (select 1 from public.suppliers where id = p_supplier and store_id = v_store) then
    raise exception 'Please choose one of your own suppliers.';
  end if;
  if p_max is not null and p_max < coalesce(p_min, 0) then raise exception 'The maximum must be more than the minimum.'; end if;
  if p_id is null then
    if exists (select 1 from public.ingredients where store_id = v_store and lower(trim(name)) = lower(trim(p_name))) then
      raise exception 'You already have an ingredient called "%".', trim(p_name);
    end if;
    insert into public.ingredients (store_id, name, unit, min_level, max_level, supplier_id, cost_per_unit)
    values (v_store, trim(p_name), p_unit, coalesce(p_min, 0), p_max, p_supplier, p_cost) returning * into v;
    if coalesce(p_start_qty, 0) > 0 then perform public.move_ingredient(v.id, p_start_qty, 'restock', null, 'Starting stock'); end if;
    perform public.audit_inventory('ingredient_created', v.id, v.name, coalesce(p_start_qty, 0) || ' ' || p_unit);
    select * into v from public.ingredients where id = v.id;
  else
    select * into v_old from public.ingredients where id = p_id and store_id = v_store;
    if not found then raise exception 'Ingredient not found.'; end if;
    update public.ingredients set name = trim(p_name), unit = p_unit, min_level = coalesce(p_min, 0), max_level = p_max,
           supplier_id = p_supplier, cost_per_unit = p_cost, updated_at = now(),
           low_alerted = case when quantity >= coalesce(p_min, 0) then false else low_alerted end
     where id = p_id returning * into v;
    if v_old.cost_per_unit is distinct from v.cost_per_unit or v_old.unit is distinct from v.unit or v_old.min_level is distinct from v.min_level then
      perform public.audit_inventory('ingredient_updated', v.id, v.name,
        'cost ' || coalesce(v_old.cost_per_unit::text, 'none') || ' -> ' || coalesce(v.cost_per_unit::text, 'none')
        || ', min ' || v_old.min_level || ' -> ' || v.min_level || ', unit ' || v_old.unit || ' -> ' || v.unit);
    end if;
  end if;
  return v;
end $$;

create or replace function public.restock_ingredient(p_id uuid, p_qty numeric, p_batch_code text default null, p_expires_on date default null, p_cost numeric default null)
returns public.ingredients
language plpgsql security definer set search_path = public as $$
declare v public.ingredients;
begin
  select * into v from public.ingredients where id = p_id;
  if not found then raise exception 'Ingredient not found.'; end if;
  perform public.assert_store_perm(v.store_id, 'manage_inventory');
  if p_qty is null or p_qty <= 0 then raise exception 'Please enter how much arrived.'; end if;
  perform public.move_ingredient(p_id, p_qty, 'restock', null, coalesce('Batch ' || nullif(trim(p_batch_code), ''), null));
  if p_expires_on is not null or nullif(trim(coalesce(p_batch_code, '')), '') is not null then
    insert into public.ingredient_batches (ingredient_id, store_id, batch_code, quantity, expires_on, created_by)
    values (p_id, v.store_id, nullif(trim(coalesce(p_batch_code, '')), ''), p_qty, p_expires_on, auth.uid());
  end if;
  if p_cost is not null and p_cost >= 0 and p_cost is distinct from v.cost_per_unit then
    update public.ingredients set cost_per_unit = p_cost where id = p_id;
    perform public.audit_inventory('ingredient_cost_changed', v.id, v.name, coalesce(v.cost_per_unit::text, 'none') || ' -> ' || p_cost);
  end if;
  select * into v from public.ingredients where id = p_id;
  return v;
end $$;

create or replace function public.correct_ingredient(p_id uuid, p_counted numeric, p_note text)
returns public.ingredients
language plpgsql security definer set search_path = public as $$
declare v public.ingredients;
begin
  select * into v from public.ingredients where id = p_id;
  if not found then raise exception 'Ingredient not found.'; end if;
  perform public.assert_store_perm(v.store_id, 'manage_inventory');
  if p_counted is null or p_counted < 0 then raise exception 'Please enter the amount you counted.'; end if;
  if coalesce(char_length(trim(p_note)), 0) < 3 then raise exception 'Please say why (e.g. weekly count).'; end if;
  if p_counted <> v.quantity then
    perform public.move_ingredient(p_id, p_counted - v.quantity, 'correction', null, p_note);
    perform public.audit_inventory('ingredient_corrected', v.id, v.name, v.quantity || ' -> ' || p_counted || ' ' || v.unit || ': ' || trim(p_note));
  end if;
  select * into v from public.ingredients where id = p_id;
  return v;
end $$;

create or replace function public.set_recipe(p_menu_item uuid, p_lines jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid;
  l jsonb;
begin
  select store_id into v_store from public.menu_items where id = p_menu_item;
  perform public.assert_store_perm(v_store, 'manage_inventory');
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) > 30 then raise exception 'Invalid recipe.'; end if;
  delete from public.recipe_items where menu_item_id = p_menu_item;
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    if not exists (select 1 from public.ingredients where id = (l->>'ingredient_id')::uuid and store_id = v_store) then
      raise exception 'Recipes can only use your own ingredients.';
    end if;
    if coalesce((l->>'quantity')::numeric, 0) <= 0 then raise exception 'Each ingredient needs an amount above 0.'; end if;
    insert into public.recipe_items (menu_item_id, ingredient_id, quantity)
    values (p_menu_item, (l->>'ingredient_id')::uuid, (l->>'quantity')::numeric)
    on conflict (menu_item_id, ingredient_id) do update set quantity = excluded.quantity;
  end loop;
end $$;

create or replace function public.archive_ingredient(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v public.ingredients;
begin
  select * into v from public.ingredients where id = p_id;
  if not found then raise exception 'Ingredient not found.'; end if;
  perform public.assert_store_perm(v.store_id, 'manage_inventory');
  update public.ingredients set active = false where id = p_id;
  delete from public.recipe_items where ingredient_id = p_id;
  perform public.audit_inventory('ingredient_removed', v.id, v.name, null);
end $$;

-- ---------- Waste (managers and kitchen) ----------
create or replace function public.record_waste(p_ingredient uuid, p_quantity numeric, p_reason text, p_note text default null, p_batch uuid default null)
returns public.waste_records
language plpgsql security definer set search_path = public as $$
declare
  v public.ingredients;
  w public.waste_records;
begin
  select * into v from public.ingredients where id = p_ingredient;
  if not found or not public.is_store_staff(v.store_id) then raise exception 'Only this shop''s staff can record waste.'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Please enter how much was thrown away.'; end if;
  if p_reason not in ('spoiled', 'burned', 'incorrect_preparation', 'customer_cancellation', 'expired', 'other') then raise exception 'Please choose a reason.'; end if;
  insert into public.waste_records (store_id, ingredient_id, ingredient_name, quantity, unit, estimated_cost, reason, note, recorded_by, recorded_by_name)
  values (v.store_id, v.id, v.name, p_quantity, v.unit, case when v.cost_per_unit is not null then round(v.cost_per_unit * p_quantity, 2) end,
          p_reason, nullif(left(trim(coalesce(p_note, '')), 200), ''), auth.uid(), public.first_name_of(auth.uid()))
  returning * into w;
  perform public.move_ingredient(v.id, -p_quantity, 'waste', null, p_reason);
  if p_batch is not null then
    update public.ingredient_batches set status = 'discarded' where id = p_batch and ingredient_id = v.id;
  end if;
  return w;
end $$;

-- Mark a batch as finished (used up) — no stock change, just stops expiry warnings.
create or replace function public.close_batch(p_batch uuid)
returns void language plpgsql security definer set search_path = public as $$
declare b public.ingredient_batches;
begin
  select * into b from public.ingredient_batches where id = p_batch;
  if not found or not public.is_store_staff(b.store_id) then raise exception 'Batch not found.'; end if;
  update public.ingredient_batches set status = 'used' where id = p_batch;
end $$;

revoke all on function public.save_ingredient(uuid, text, text, numeric, numeric, uuid, numeric, numeric) from public, anon;
revoke all on function public.restock_ingredient(uuid, numeric, text, date, numeric) from public, anon;
revoke all on function public.correct_ingredient(uuid, numeric, text) from public, anon;
revoke all on function public.set_recipe(uuid, jsonb) from public, anon;
revoke all on function public.archive_ingredient(uuid) from public, anon;
revoke all on function public.record_waste(uuid, numeric, text, text, uuid) from public, anon;
revoke all on function public.close_batch(uuid) from public, anon;
revoke all on function public.kitchen_ingredients() from public, anon;
grant execute on function public.save_ingredient(uuid, text, text, numeric, numeric, uuid, numeric, numeric) to authenticated;
grant execute on function public.restock_ingredient(uuid, numeric, text, date, numeric) to authenticated;
grant execute on function public.correct_ingredient(uuid, numeric, text) to authenticated;
grant execute on function public.set_recipe(uuid, jsonb) to authenticated;
grant execute on function public.archive_ingredient(uuid) to authenticated;
grant execute on function public.record_waste(uuid, numeric, text, text, uuid) to authenticated;
grant execute on function public.close_batch(uuid) to authenticated;
grant execute on function public.kitchen_ingredients() to authenticated;
