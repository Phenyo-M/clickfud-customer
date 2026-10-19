-- ============================================================
-- CLICKFOOD, collection code check (2026-10-16)
--
-- A real code was refused at Kota Hub. Codes use only 0-9 and A-F, and a
-- typed letter O for the zero (or I / L for one) never matched. Now the
-- check ignores spaces, dashes and '#', and reads O as 0 and I / L as 1
-- (those letters never appear in a code). Typing the ORDER NUMBER instead
-- of the code gets its own clear message. A wrong code is still refused.
-- Built from the LIVE definitions of confirm_collection (manager/kitchen)
-- and seller_update_order (student sellers); only the code check changed.
-- Safe to run more than once.
-- ============================================================

create or replace function public.normalize_collection_code(p text)
returns text language sql immutable as $$
  select translate(regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]', '', 'g'), 'OIL', '011')
$$;

create or replace function public.collection_code_matches(o public.orders, p_code text)
returns boolean language sql stable as $$
  select o.collection_code is not null
     and public.normalize_collection_code(p_code) <> ''
     and public.normalize_collection_code(p_code) in (public.normalize_collection_code(o.collection_code),
                                                      public.normalize_collection_code(o.collection_token::text))
$$;

-- "ORD-2026-00133", "ORD202600133", "00133" or "133" typed into the code box
create or replace function public.is_order_number_entry(o public.orders, p_code text)
returns boolean language sql stable as $$
  select o.order_number is not null and public.normalize_collection_code(p_code) <> ''
     and not public.collection_code_matches(o, p_code)
     and (public.normalize_collection_code(p_code) = public.normalize_collection_code(o.order_number)
          or ltrim(public.normalize_collection_code(p_code), '0') = ltrim(regexp_replace(o.order_number, '^.*-', ''), '0'))
$$;

revoke all on function public.normalize_collection_code(text), public.collection_code_matches(public.orders, text),
  public.is_order_number_entry(public.orders, text) from public, anon, authenticated;

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
  if public.is_order_number_entry(v_order, p_code) then
    raise exception 'That is the order number. Enter the 6-character collection code from the customer''s screen.';
  end if;
  if not public.collection_code_matches(v_order, p_code) then
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
    if public.is_order_number_entry(o, p_code) then
      raise exception 'That is the order number. Enter the 6-character collection code from the buyer''s screen.';
    end if;
    if not public.collection_code_matches(o, p_code) then
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
