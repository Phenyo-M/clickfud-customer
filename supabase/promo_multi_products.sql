-- ============================================================
-- NEW (2026-09-29) — A PROMO CODE CAN COVER SEVERAL PRODUCTS
--
-- Replaces the single promotions.menu_item_id (promo_products.sql, same
-- day) with a list: promotions.menu_item_ids. The manager ticks the
-- products the code is for; the discount is worked out ONLY on those
-- products' lines in the cart.
--   percentage: X% of (those products' price incl. extras x qty)
--   fixed:      R X off once per order, at most those products' total
-- All chosen products must belong to ONE shop (the manager's own); the
-- code's store_id is derived from them. Mirrored in paystack-initialize /
-- paystack-charge-saved and js/promotions.js.
-- Safe to run more than once.
-- ============================================================

alter table public.promotions add column if not exists menu_item_ids uuid[];
alter table public.promotions add column if not exists store_id uuid references public.stores(id) on delete cascade;
create index if not exists promotions_store_id_idx on public.promotions(store_id);
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'promotions' and column_name = 'menu_item_id') then
    update public.promotions set menu_item_ids = array[menu_item_id] where menu_item_id is not null and menu_item_ids is null;
    alter table public.promotions drop column menu_item_id;
  end if;
end $$;

create or replace function public.enforce_promo_product()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_found int;
  v_stores int;
  v_store uuid;
begin
  -- de-duplicate, drop nulls
  new.menu_item_ids := nullif(array(select distinct x from unnest(coalesce(new.menu_item_ids, '{}'::uuid[])) x where x is not null), '{}'::uuid[]);
  if new.menu_item_ids is null then
    new.store_id := null;
    if auth.uid() is not null and (tg_op = 'INSERT' or new.active) then
      raise exception 'Choose at least one product this promo code is for.' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  select count(*), count(distinct store_id), min(store_id::text)::uuid
    into v_found, v_stores, v_store
    from public.menu_items where id = any (new.menu_item_ids);
  if v_found <> cardinality(new.menu_item_ids) then
    raise exception 'One or more of the chosen products no longer exist.' using errcode = 'check_violation';
  end if;
  if v_stores <> 1 then
    raise exception 'All products on one promo code must be from the same shop.' using errcode = 'check_violation';
  end if;
  if auth.uid() is not null and public.current_role() = 'manager' and v_store is distinct from public.current_store_id() then
    raise exception 'You can only create promo codes for your own shop''s products.' using errcode = 'check_violation';
  end if;
  new.store_id := v_store;
  return new;
end;
$$;
drop trigger if exists trg_enforce_promo_product on public.promotions;
create trigger trg_enforce_promo_product
  before insert or update on public.promotions
  for each row execute function public.enforce_promo_product();

create or replace function public.validate_order_pricing()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_item jsonb;
  v_items jsonb := '[]'::jsonb;
  v_menu_item public.menu_items;
  v_addon public.menu_addons;
  v_addons_total numeric(10,2);
  v_addons_out jsonb;
  v_addon_obj jsonb;
  v_extra_id uuid;
  v_item_extra public.item_extras;
  v_unit_price numeric(10,2);
  v_qty int;
  v_subtotal numeric(10,2) := 0;
  v_promo public.promotions;
  v_max_discount numeric(10,2);
  v_eligible numeric(10,2);
begin
  if new.store_id is null then
    raise exception 'Order must belong to a store.';
  end if;
  if jsonb_array_length(coalesce(new.items, '[]'::jsonb)) = 0 then
    raise exception 'Order must contain at least one item.';
  end if;

  for v_item in select * from jsonb_array_elements(new.items)
  loop
    v_qty := greatest(1, coalesce((v_item->>'qty')::int, 1));

    if coalesce((v_item->>'isAddon')::boolean, false) then
      select * into v_addon from public.menu_addons
        where id = (v_item->>'menuItemId')::uuid and store_id = new.store_id;
      if not found or not v_addon.is_available then
        raise exception 'One or more add-ons in this order are no longer available.';
      end if;
      v_unit_price := v_addon.price;
      v_addons_out := '[]'::jsonb;
    else
      select * into v_menu_item from public.menu_items
        where id = (v_item->>'menuItemId')::uuid and store_id = new.store_id;
      if not found or not v_menu_item.available then
        raise exception 'One or more items in this order are no longer available.';
      end if;
      if v_menu_item.stock < v_qty then
        raise exception 'Only % left of "%".', v_menu_item.stock, v_menu_item.name;
      end if;

      -- Per-product extras (public.item_extras / public.item_extra_links,
      -- manager-configured - never a fixed/hardcoded list). Every extra id
      -- the client sent is re-looked-up here: it must be linked to THIS
      -- exact menu item, belong to this store, and currently be
      -- available, or the whole order is rejected. The name/price stored
      -- on the order always come from this live lookup, never from
      -- whatever the client sent - a tampered name or price can't slip
      -- through even if a tampered id happens to resolve to something.
      v_addons_total := 0;
      v_addons_out := '[]'::jsonb;
      if jsonb_typeof(v_item->'addons') = 'array' then
        for v_addon_obj in select * from jsonb_array_elements(v_item->'addons')
        loop
          begin
            v_extra_id := (v_addon_obj->>'id')::uuid;
          exception when others then
            raise exception 'Invalid extra selection.';
          end;
          select ie.* into v_item_extra from public.item_extras ie
            join public.item_extra_links iel on iel.item_extra_id = ie.id
            where ie.id = v_extra_id
              and iel.menu_item_id = v_menu_item.id
              and ie.store_id = new.store_id
              and ie.available = true;
          if not found then
            raise exception 'One or more selected extras are no longer available for "%".', v_menu_item.name;
          end if;
          v_addons_total := v_addons_total + v_item_extra.price;
          v_addons_out := v_addons_out || jsonb_build_object('id', v_item_extra.id, 'name', v_item_extra.name, 'price', v_item_extra.price);
        end loop;
      end if;

      v_unit_price := v_menu_item.price + v_addons_total;
    end if;

    v_items := v_items || jsonb_build_object(
      'menuItemId', v_item->>'menuItemId',
      'name', v_item->>'name',
      'price', round(v_unit_price, 2),
      'qty', v_qty,
      'image', v_item->'image',
      'addons', v_addons_out,
      'specialInstructions', coalesce(v_item->>'specialInstructions', ''),
      'isAddon', coalesce((v_item->>'isAddon')::boolean, false)
    );
    v_subtotal := v_subtotal + round(v_unit_price, 2) * v_qty;
  end loop;

  new.items := v_items;
  new.subtotal := round(v_subtotal, 2);
  new.delivery_fee := round(coalesce(new.delivery_fee, 0), 2);

  if new.promo_code is not null then
    select * into v_promo from public.promotions where code = new.promo_code;
    if not found or not v_promo.active
       or (v_promo.expires_at is not null and v_promo.expires_at < now())
       or (v_promo.usage_limit is not null and v_promo.used_count >= v_promo.usage_limit) then
      v_max_discount := 0;
      new.promo_code := null;
    else
      -- Product code: only the chosen products' lines count (price
      -- + extras + platform fee, as the customer was charged). A legacy
      -- code with no product still counts the whole order.
      if coalesce(cardinality(v_promo.menu_item_ids), 0) = 0 then
        v_eligible := new.subtotal;
      else
        select coalesce(sum(((e->>'price')::numeric + coalesce(mi.platform_fee_amount, 0)) * (e->>'qty')::int), 0)
          into v_eligible
          from jsonb_array_elements(v_items) e
          join public.menu_items mi on mi.id::text = e->>'menuItemId'
          where mi.id = any (v_promo.menu_item_ids)
            and not coalesce((e->>'isAddon')::boolean, false);
      end if;
      if v_eligible <= 0 then
        v_max_discount := 0;
        new.promo_code := null;
      elsif v_promo.type = 'percentage' then
        v_max_discount := round(v_eligible * (v_promo.value / 100), 2);
      else
        v_max_discount := least(v_promo.value, v_eligible);
      end if;
    end if;
    new.discount := least(greatest(coalesce(new.discount, 0), 0), v_max_discount);
  else
    new.discount := 0;
  end if;

  new.total := greatest(0, new.subtotal + new.delivery_fee - new.discount);

  return new;
end;
$function$;
