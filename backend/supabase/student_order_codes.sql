-- ============================================================
-- ClickFood: collection code for student orders (2026-10-13)
-- Runs after student_sellers.sql.
--
-- When a student seller marks an order ready, it gets a 6-character
-- collection code (same as campus shops). The buyer shows it; the seller
-- must enter it to mark the order collected and completed. No timed
-- collection window for student orders (that stays campus-only).
-- seller_update_order() gains p_code (required for 'complete').
-- Safe to run more than once.
-- ============================================================

create or replace function public.generate_collection_code()
returns trigger language plpgsql set search_path = public as $function$
begin
  if new.status = 'ready' and old.status is distinct from 'ready'
     and coalesce(new.delivery_location->>'fulfilment', '') = 'collection' then
    if new.collection_token is null then
      new.collection_token := gen_random_uuid();
    end if;
    if new.collection_code is null then
      new.collection_code := upper(substr(replace(coalesce(new.collection_token, gen_random_uuid())::text, '-', ''), 1, 6));
    end if;
  end if;
  return new;
end;
$function$;

drop function if exists public.seller_update_order(uuid, text, text, text);

create or replace function public.seller_update_order(p_order_id uuid, p_action text, p_reason text default null,
                                                      p_note text default null, p_code text default null)
returns public.orders
language plpgsql security definer set search_path = public as $$
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
  insert into public.notifications (user_id, message, type)
  values (o.customer_id, v_msg, case v_new when 'cancelled' then 'order_cancelled' when 'collected' then 'delivered' else v_new end);
  return o;
end $$;
revoke all on function public.seller_update_order(uuid, text, text, text, text) from public, anon;
grant execute on function public.seller_update_order(uuid, text, text, text, text) to authenticated;

-- Student sellers have no UPDATE policy on orders; they only change an
-- order through seller_update_order(). Let that path set the collection
-- code (made by generate_collection_code) and the collected time, which
-- this guard used to put back for every non-staff account.
create or replace function public.protect_order_updates()
returns trigger language plpgsql security definer set search_path = public as $function$
declare v_own_student_shop boolean;
begin
  if public.current_role() not in ('manager','kitchen','cashier','driver','dispatcher') then
    v_own_student_shop := new.store_id = public.current_seller_store_id();
    new.customer_id := old.customer_id;
    new.items := old.items;
    new.subtotal := old.subtotal;
    new.delivery_fee := old.delivery_fee;
    new.discount := old.discount;
    new.promo_code := old.promo_code;
    new.total := old.total;
    new.payment_method := old.payment_method;
    new.payment_status := old.payment_status;
    new.cash_tendered := old.cash_tendered;
    new.delivery_location := old.delivery_location;
    new.assigned_driver := old.assigned_driver;
    new.priority := old.priority;
    new.eta := old.eta;
    new.order_number := old.order_number;
    new.created_at := old.created_at;
    if not coalesce(v_own_student_shop, false) then
      new.collection_token := old.collection_token;
      new.collection_code := old.collection_code;
      new.collected_at := old.collected_at;
      new.collected_by := old.collected_by;
    end if;
  end if;
  return new;
end;
$function$;
