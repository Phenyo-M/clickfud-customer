-- =========================================================================
-- CLICKFOOD — stock stays correct when many orders arrive at once
--
-- Found by the 200-simultaneous-order load test (2026-10-06, local copy of
-- the live structure):
--  1. Lost stock updates. decrement_menu_stock read the stock, worked out
--     the new number, then wrote it back WITHOUT locking the row. Two orders
--     at the same moment both read 100 and both wrote 99. In the test, 200
--     orders of one item lowered its stock by only 16.
--  2. Deadlocks. Items were locked in the order they appear in the basket,
--     so order 1 (A then B) and order 2 (B then A) waited on each other and
--     the database cancelled one: 14 of 200 orders failed.
--
-- Fix: lock all of the order's menu items first, always sorted by id, then
-- change stock under that lock. An order placed by a person (cash) that
-- would take more than is left is refused with the same "Only N left"
-- message the app already shows. A paid card order (created by the server
-- after PayFast confirmed) is never refused: money was taken, so stock is
-- floored at 0 as before. Ingredient usage is also applied in a fixed
-- order (by ingredient id) for the same deadlock reason.
--
-- Undo: supabase/stock_concurrency_fix_rollback.sql. Safe to run twice.
-- =========================================================================
create or replace function public.decrement_menu_stock()
returns trigger
language plpgsql security definer set search_path = public
as $function$
declare
  item jsonb;
  v_item public.menu_items;
  v_new_stock int;
  v_qty int;
begin
  -- one lock per item, always in the same (id) order: no deadlocks
  perform 1 from public.menu_items
   where id in (select (e->>'menuItemId')::uuid from jsonb_array_elements(new.items) e
                 where not coalesce((e->>'isAddon')::boolean, false))
   order by id
   for update;

  for item in select * from jsonb_array_elements(new.items)
  loop
    if coalesce((item->>'isAddon')::boolean, false) then continue; end if;
    v_qty := coalesce((item->>'qty')::int, 0);
    select * into v_item from public.menu_items where id = (item->>'menuItemId')::uuid;
    if not found or v_item.stock is null then continue; end if;
    if v_item.stock < v_qty and auth.uid() is not null then
      raise exception 'Only % left of "%".', v_item.stock, v_item.name using errcode = 'P0001';
    end if;
    v_new_stock := greatest(0, v_item.stock - v_qty);

    update public.menu_items
       set stock = v_new_stock, available = (v_new_stock > 0)
     where id = v_item.id;

    insert into public.inventory_movements
      (store_id, menu_item_id, movement_type, quantity_change, opening_stock, closing_stock, order_id)
    values
      (new.store_id, v_item.id, 'sale', -(v_item.stock - v_new_stock), v_item.stock, v_new_stock, new.id);
  end loop;
  return new;
end;
$function$;

create or replace function public.order_ingredient_usage()
returns trigger
language plpgsql security definer set search_path = public
as $function$
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
      order by ri.ingredient_id          -- fixed lock order: no deadlocks
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
      order by ingredient_id
    loop
      perform public.move_ingredient(r.ingredient_id, r.back, 'returned', new.id, 'Order cancelled before it was made');
    end loop;
  end if;
  return new;
end $function$;
