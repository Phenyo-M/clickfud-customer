-- =========================================================================
-- CLICKFOOD — undo supabase/stock_concurrency_fix.sql
-- The exact definitions that were live on 2026-10-06 before it. (This brings
-- back the lost-stock-update and deadlock problems: back out, then fix forward.)
-- =========================================================================
CREATE OR REPLACE FUNCTION public.decrement_menu_stock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  item jsonb;
  v_old_stock int;
  v_new_stock int;
  v_qty int;
begin
  for item in select * from jsonb_array_elements(new.items)
  loop
    v_qty := coalesce((item->>'qty')::int, 0);
    select stock into v_old_stock from public.menu_items where id = (item->>'menuItemId')::uuid;
    if v_old_stock is null then continue; end if;
    v_new_stock := greatest(0, v_old_stock - v_qty);

    update public.menu_items
    set stock = v_new_stock, available = (v_new_stock > 0)
    where id = (item->>'menuItemId')::uuid;

    insert into public.inventory_movements
      (store_id, menu_item_id, movement_type, quantity_change, opening_stock, closing_stock, order_id)
    values
      (new.store_id, (item->>'menuItemId')::uuid, 'sale', -(v_old_stock - v_new_stock), v_old_stock, v_new_stock, new.id);
  end loop;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.order_ingredient_usage()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
