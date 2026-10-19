-- ============================================================
-- Undo supabase/notification_queue.sql: the four order functions go back
-- to their live versions (with their own notification inserts), the
-- student seller trigger returns, the old insert policy returns, and the
-- queue tables are removed (their rows are only delivery bookkeeping).
-- ============================================================
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname in ('notification-worker', 'notification-jobs-cleanup');
  end if;
end $$;
drop trigger if exists trg_zz_queue_order_notifications on public.orders;
drop trigger if exists trg_sync_email_job_status on public.email_outbox;
drop function if exists public.queue_order_notifications();
drop function if exists public.sync_email_job_status();
drop function if exists public.order_notification_events(public.orders, public.orders);
drop function if exists public.claim_notification_jobs(text, int);
drop function if exists public.finish_notification_job(uuid, boolean, text, text, boolean);
drop function if exists public.queue_notification_fallback(uuid, text);
drop function if exists public.mark_notifications_delivered(uuid[]);
drop function if exists public.kick_notification_worker_if_due();
drop function if exists public.kick_notification_worker();
drop function if exists public.notification_allowed(uuid, text, text);
drop table if exists public.notification_jobs;
drop table if exists public.notification_errors;
drop table if exists public.notification_channel_rules;
drop table if exists public.notification_preferences;
drop table if exists public.notification_worker_config;
alter table public.push_subscriptions drop column if exists invalid_at;
drop index if exists public.notifications_job_id;
alter table public.notifications drop column if exists job_id;

drop policy if exists "notif insert allowed" on public.notifications;
create policy "notif insert allowed" on public.notifications for insert
  with check ((user_id = auth.uid()) OR (public."current_role"() = 'developer'::text) OR ((public."current_role"() = ANY (ARRAY['manager'::text, 'kitchen'::text])) AND (EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.customer_id = notifications.user_id) AND (o.store_id = public.current_store_id()))))));

CREATE OR REPLACE FUNCTION public.notify_student_seller()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_owner uuid;
begin
  select manager_id into v_owner from public.stores where id = new.store_id and seller_kind = 'student';
  if v_owner is not null then
    insert into public.notifications (user_id, message, type)
    values (v_owner, 'New order ' || coalesce(new.order_number, '') || ' from ' || public.first_name_of(new.customer_id) || '.', 'seller_order');
  end if;
  return new;
end $function$;
drop trigger if exists trg_notify_student_seller on public.orders;
create trigger trg_notify_student_seller after insert on public.orders
  for each row execute function public.notify_student_seller();

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

  insert into public.notifications (user_id, message, type)
  values (v_order.customer_id, 'Order ' || v_order.order_number || ' collected. Enjoy your meal!', 'delivered');

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
  insert into public.notifications (user_id, message, type)
  values (o.customer_id, v_msg, case v_new when 'cancelled' then 'order_cancelled' when 'collected' then 'delivered' else v_new end);
  return o;
end $function$;

CREATE OR REPLACE FUNCTION public.staff_cancel_order(p_order_id uuid, p_reason text, p_note text DEFAULT NULL::text)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order public.orders;
  v_role text := public.current_role();
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  if v_role not in ('manager', 'kitchen') or v_order.store_id is distinct from public.current_store_id() then
    raise exception 'Only this shop''s staff can cancel its orders.';
  end if;
  if v_order.status not in ('received', 'preparing', 'ready') then
    raise exception 'This order can no longer be cancelled.';
  end if;
  if v_order.payment_method = 'card' and v_order.payment_status = 'paid' then
    raise exception 'This order was paid by card. Refund it from Refunds instead of cancelling it here.';
  end if;
  if p_reason is null or p_reason not in ('kitchen_cancelled', 'product_unavailable', 'payment_problem', 'restaurant_closed', 'other') then
    raise exception 'Please choose a reason.';
  end if;
  update public.orders
     set status = 'cancelled', cancel_reason = p_reason, cancel_note = nullif(left(trim(coalesce(p_note, '')), 200), ''),
         status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('status', 'cancelled', 'at', now()))
   where id = p_order_id returning * into v_order;
  insert into public.notifications (user_id, message, type)
  values (v_order.customer_id, 'Sorry, ' || coalesce((select name from public.stores where id = v_order.store_id), 'the shop')
          || ' cancelled your order ' || coalesce(v_order.order_number, '') || '. '
          || case p_reason when 'product_unavailable' then 'An item in it is no longer available.'
                           when 'restaurant_closed' then 'The shop had to close.'
                           else coalesce(nullif(trim(coalesce(p_note, '')), ''), 'Please contact the shop if you have questions.') end,
          'order_cancelled');
  return v_order;
end $function$;

CREATE OR REPLACE FUNCTION public.finalize_paystack_checkout(p_reference text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_session public.checkout_sessions;
  v_group jsonb;
  v_order public.orders;
  v_order_ids jsonb := '[]'::jsonb;
begin
  select * into v_session from public.checkout_sessions where reference = p_reference for update;
  if not found then
    raise exception 'Unknown checkout session.';
  end if;

  if v_session.group_id is not null then
    return public.finalize_group_share(p_reference);
  end if;

  if v_session.status = 'paid' then
    return jsonb_build_object('order_ids', v_session.order_ids);
  end if;

  for v_group in select * from jsonb_array_elements(v_session.groups)
  loop
    insert into public.orders (
      customer_id, store_id, items, subtotal, delivery_fee, discount, promo_code, total,
      payment_method, payment_status, payment_reference, delivery_location, status, status_history,
      paystack_subaccount_code, payout_amount, platform_fee_amount
    ) values (
      v_session.customer_id,
      (v_group->>'storeId')::uuid,
      v_group->'items',
      (v_group->>'subtotal')::numeric,
      0,
      coalesce((v_group->>'discount')::numeric, 0),
      v_group->>'promoCode',
      (v_group->>'total')::numeric,
      'card',
      'paid',
      p_reference,
      v_group->'deliveryLocation',
      'preparing',
      jsonb_build_array(jsonb_build_object('status', 'received', 'at', now()), jsonb_build_object('status', 'preparing', 'at', now())),
      v_group->>'subaccountCode',
      (v_group->>'shopAmount')::numeric,
      coalesce((v_group->>'platformFeeAmount')::numeric, 0)
    )
    returning * into v_order;

    v_order_ids := v_order_ids || to_jsonb(v_order.id);

    insert into public.notifications (user_id, message, type)
    values (
      v_session.customer_id,
      'Payment successful! Your order ' || v_order.order_number || ' has been successfully placed.',
      'order_received'
    );
  end loop;

  update public.checkout_sessions
    set status = 'paid', order_ids = v_order_ids, updated_at = now()
    where reference = p_reference;

  return jsonb_build_object('order_ids', v_order_ids);
end;
$function$;
