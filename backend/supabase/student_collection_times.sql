-- ============================================================
-- ClickFood: student food is collected on a chosen day and time (2026-10-13)
-- Runs after seller_review_address.sql (replaces student_order_insert).
--
-- Campus shops: unchanged (order while open, collect soon after).
-- Student shops: the buyer picks a day the shop sells and a time inside
-- its hours, up to 7 days ahead. So a student shop that is closed right
-- now can still take an order for later; a PAUSED shop takes none. The
-- chosen time (delivery_location.collectionTime) is checked here.
-- Safe to run more than once.
-- ============================================================

-- Is this moment a time the student shop sells? (SA time, its days + hours)
create or replace function public.student_collection_ok(p_store uuid, p_at timestamptz)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  s public.stores;
  v_local timestamp := p_at at time zone 'Africa/Johannesburg';
  v_dow int := extract(dow from v_local)::int;
  v_t time := v_local::time;
  o time; c time;
begin
  select * into s from public.stores where id = p_store;
  if not found then return false; end if;
  if p_at < now() - interval '5 minutes' or p_at > now() + interval '8 days' then return false; end if;
  select h.open_t, h.close_t into o, c from public.store_hours_on(s, v_dow) h;
  if o is null then return false; end if;
  if c = o then return true; end if;              -- open all day
  if c > o then return v_t >= o and v_t <= c; end if;
  return v_t >= o or v_t <= c;                    -- runs past midnight
end $$;

create or replace function public.ordering_block_reason(p_store_id uuid, p_item_ids uuid[])
returns text language plpgsql stable security definer set search_path = public as $function$
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
  -- student shops take orders for a later day/time (checked in student_order_insert)
  if v_status->>'state' = 'closed' and not public.is_student_store(p_store_id) then
    return coalesce(v_name, 'This shop') || ' is closed right now. Please order during its opening hours.';
  end if;
  for m in select id, name, available, availability_windows from public.menu_items
           where id = any (coalesce(p_item_ids, '{}')) and store_id = p_store_id loop
    if not m.available then
      return '"' || m.name || '" is sold out right now.';
    end if;
    if not public.is_student_store(p_store_id) and not public.menu_item_window_ok(m.availability_windows) then
      return '"' || m.name || '" isn''t available at this time of day.';
    end if;
  end loop;
  return null;
end $function$;

create or replace function public.student_order_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_published boolean; v_at timestamptz;
begin
  select manager_id, is_published into v_owner, v_published from public.stores where id = new.store_id and seller_kind = 'student';
  if not found then return new; end if;
  if not coalesce(v_published, false) then
    raise exception 'This shop isn''t open on ClickFood yet.' using errcode = 'P0001';
  end if;
  if new.customer_id = v_owner then
    raise exception 'You can''t order from your own shop.' using errcode = 'P0001';
  end if;
  begin v_at := (new.delivery_location->>'collectionTime')::timestamptz; exception when others then v_at := null; end;
  if v_at is null then
    raise exception 'Please choose a collection day and time.' using errcode = 'P0001';
  end if;
  if not public.student_collection_ok(new.store_id, v_at) then
    raise exception 'That collection time isn''t one this shop sells. Please choose another day or time.' using errcode = 'P0001';
  end if;
  new.status := 'received';
  new.payment_method := 'cod';
  new.payment_status := 'pending';
  new.promo_code := null;
  new.discount := 0;
  new.delivery_fee := 0;
  new.platform_fee_amount := 0;
  new.delivery_location := coalesce(new.delivery_location, '{}'::jsonb)
    || jsonb_build_object('fulfilment', 'collection', 'payment', 'direct',
                          'customerName', public.first_name_of(new.customer_id),
                          'instructions', left(btrim(coalesce(new.delivery_location->>'instructions', '')), 300));
  return new;
end $$;
