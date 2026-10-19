-- Rollback for collection_code_fix.sql: the definitions live before 2026-10-16.
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

drop function if exists public.is_order_number_entry(public.orders, text);
drop function if exists public.collection_code_matches(public.orders, text);
drop function if exists public.normalize_collection_code(text);
