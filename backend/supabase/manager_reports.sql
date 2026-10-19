-- =========================================================================
-- ClickFood — Phase 2: manager money and reports (2026-10-01)
--
--  * orders.cancel_reason (+ cancel_note) — why an order was cancelled.
--    Filled automatically when nobody gives a reason (customer vs shop),
--    or chosen by staff. Older cancellations stay "not recorded".
--  * store_sales_report(from, to) — every figure on the manager's Reports
--    tab, worked out on the server from real orders, in South African dates.
--    Only the shop's MANAGER can run it (kitchen staff get no money figures).
--  * refund_requests + request_refund / decide_refund / mark_refund_paid —
--    full or partial refunds with a who/when/why trail; an order can never
--    be refunded for more than was paid, and only one request can be open
--    at a time. Card refunds are paid out by the process-refund Edge
--    Function (Paystack); cash refunds are marked paid by the manager.
--    Store credit is NOT included yet (it needs checkout support first).
--
-- "Valid sale" everywhere below = an order that was collected (or delivered,
-- for old orders), or a paid card order that was never collected (the shop
-- kept the money). Cancelled orders are never sales.
-- Safe to run more than once.
-- =========================================================================

-- ---------- Cancellation reasons ----------
alter table public.orders add column if not exists cancel_reason text;
alter table public.orders add column if not exists cancel_note text;
do $$ begin
  alter table public.orders add constraint orders_cancel_reason_valid check (cancel_reason is null or cancel_reason in
    ('customer_cancelled', 'kitchen_cancelled', 'product_unavailable', 'payment_problem', 'restaurant_closed', 'other'));
exception when duplicate_object then null; end $$;

create or replace function public.fill_cancel_reason()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' and new.cancel_reason is null then
    if auth.uid() is not null and auth.uid() = new.customer_id then
      new.cancel_reason := 'customer_cancelled';
    elsif public.current_role() in ('manager', 'kitchen') then
      new.cancel_reason := 'kitchen_cancelled';
    end if;
  end if;
  if new.cancel_note is not null then new.cancel_note := left(trim(new.cancel_note), 200); end if;
  return new;
end $$;
drop trigger if exists trg_fill_cancel_reason on public.orders;
create trigger trg_fill_cancel_reason before update on public.orders
  for each row execute function public.fill_cancel_reason();

create index if not exists orders_store_created_idx on public.orders (store_id, created_at);

-- ---------- Helpers ----------
create or replace function public.is_valid_sale(p_status text, p_payment_status text)
returns boolean language sql immutable as $$
  select p_status in ('collected', 'delivered') or (p_status = 'uncollected' and p_payment_status = 'paid')
$$;

-- ---------- The report ----------
create or replace function public.store_sales_report(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.current_store_id();
  v_tz text := 'Africa/Johannesburg';
  v_days int;
  v_out jsonb;
begin
  perform public.assert_store_perm(v_store, 'view_reports');   -- manager, or a login given "Reports" (staff_permissions.sql)
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Please choose a valid date range.';
  end if;
  if p_to - p_from > 366 then
    raise exception 'Please choose a range of one year or less.';
  end if;
  v_days := p_to - p_from + 1;

  with o as (
    select o.*, (o.created_at at time zone v_tz) as local_ts, (o.created_at at time zone v_tz)::date as local_day,
           public.is_valid_sale(o.status, o.payment_status) as valid
    from public.orders o
    where o.store_id = v_store
      and (o.created_at at time zone v_tz)::date between p_from and p_to
  ),
  sales as (select * from o where valid),
  lines as (
    select s.id as order_id, coalesce(e->>'menuItemId', '') as item_id,
           coalesce(mi.name, e->>'name', 'Item') as name,   -- the menu's own name, never what the app sent
           greatest(1, coalesce((e->>'qty')::int, 1)) as qty,
           coalesce((e->>'price')::numeric, 0) * greatest(1, coalesce((e->>'qty')::int, 1)) as revenue
    from sales s cross join lateral jsonb_array_elements(coalesce(s.items, '[]'::jsonb)) e
    left join public.menu_items mi on mi.id::text = e->>'menuItemId'
    where not coalesce((e->>'isAddon')::boolean, false)
  ),
  prod as (
    select item_id, max(name) as name, sum(qty)::int as units, round(sum(revenue), 2) as revenue
    from lines group by item_id
  ),
  totals as (
    select count(*)::int as orders,
           coalesce(sum(total), 0)::numeric(12,2) as gross,
           coalesce(sum(discount), 0)::numeric(12,2) as discounts,
           coalesce(sum(platform_fee_amount), 0)::numeric(12,2) as platform_fees,
           count(*) filter (where status = 'uncollected')::int as paid_not_collected
    from sales
  ),
  refunds as (
    select coalesce(sum(r.amount), 0)::numeric(12,2) as amount, count(*)::int as n
    from public.refund_requests r
    where r.store_id = v_store and r.status = 'paid'
      and (r.paid_at at time zone v_tz)::date between p_from and p_to
  ),
  legacy_refunds as (   -- refunds made by the older cancel-and-refund flow
    select coalesce(sum(refund_amount), 0)::numeric(12,2) as amount
    from public.orders
    where store_id = v_store and refunded_at is not null and coalesce(refund_amount, 0) > 0
      and (refunded_at at time zone v_tz)::date between p_from and p_to
  ),
  placed as (select count(*)::int as n from o),
  cancelled as (select * from o where status = 'cancelled'),
  menu as (
    select id::text as item_id, name, created_at from public.menu_items
    where store_id = v_store and status = 'approved'
  ),
  cust_first as (
    select customer_id, min((created_at at time zone v_tz)::date) as first_day
    from public.orders
    where store_id = v_store and public.is_valid_sale(status, payment_status)
    group by customer_id
  ),
  cust_in as (select distinct customer_id from sales)
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'days', v_days,
    'summary', (select jsonb_build_object(
        'orders', t.orders, 'gross', t.gross, 'discounts', t.discounts, 'platform_fees', t.platform_fees,
        'refunds', r.amount + lr.amount, 'refund_count', r.n,
        'net', t.gross - r.amount - lr.amount,
        'aov', case when t.orders > 0 then round(t.gross / t.orders, 2) else null end,
        'paid_not_collected', t.paid_not_collected,
        'placed', p.n,
        'cancelled', (select count(*) from cancelled)::int,
        'cancel_rate', case when p.n > 0 then round(100.0 * (select count(*) from cancelled) / p.n, 1) else null end)
      from totals t, refunds r, legacy_refunds lr, placed p),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d::date,
        'orders', (select count(*) from sales s where s.local_day = d::date),
        'gross', (select coalesce(sum(total), 0) from sales s where s.local_day = d::date),
        'cancelled', (select count(*) from cancelled c where c.local_day = d::date)) order by d), '[]'::jsonb)
      from generate_series(p_from, p_to, interval '1 day') d),
    'top_products', (select coalesce(jsonb_agg(x order by x->>'rank_units' desc), '[]'::jsonb) from (
        select jsonb_build_object('name', name, 'units', units, 'revenue', revenue,
          'unit_share', round(100.0 * units / nullif((select sum(units) from prod), 0), 1),
          'revenue_share', round(100.0 * revenue / nullif((select sum(revenue) from prod), 0), 1),
          'rank_units', lpad(units::text, 8, '0')) x
        from prod order by units desc, revenue desc limit 10) t),
    'slow_moving', (select case
        when v_days < 14 then jsonb_build_object('ready', false, 'why', 'Choose at least 14 days to judge slow-moving products.')
        when (select orders from totals) < 20 then jsonb_build_object('ready', false, 'why', 'Not enough data yet. This needs at least 20 completed orders in the period.')
        else jsonb_build_object('ready', true,
          'rule', 'Products on the menu for the whole period that sold the fewest units (bottom quarter, or none at all).',
          'items', (select coalesce(jsonb_agg(jsonb_build_object('name', m.name, 'units', coalesce(p.units, 0), 'revenue', coalesce(p.revenue, 0)) order by coalesce(p.units, 0), m.name), '[]'::jsonb)
                    from menu m left join prod p on p.item_id = m.item_id
                    where (m.created_at at time zone v_tz)::date <= p_from
                      and coalesce(p.units, 0) <= coalesce((select percentile_cont(0.25) within group (order by units) from prod), 0)))
      end),
    'peak_hours', (select case when (select count(*) from o where status <> 'cancelled') < 10
        then jsonb_build_object('ready', false)
        else jsonb_build_object('ready', true,
          'hours', (select jsonb_agg(jsonb_build_object('hour', h, 'orders',
              (select count(*) from o where status <> 'cancelled' and extract(hour from local_ts) = h)) order by h)
            from generate_series(0, 23) h),
          'weekdays', (select jsonb_agg(jsonb_build_object('dow', d, 'orders',
              (select count(*) from o where status <> 'cancelled' and extract(dow from local_ts) = d)) order by d)
            from generate_series(0, 6) d))
      end),
    'cancellations', jsonb_build_object(
      'reasons', (select coalesce(jsonb_agg(jsonb_build_object('reason', reason, 'count', n) order by n desc), '[]'::jsonb)
                  from (select coalesce(cancel_reason, 'not_recorded') reason, count(*)::int n from cancelled group by 1) x),
      'products', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'units', units) order by units desc), '[]'::jsonb) from (
          select coalesce(mi.name, e->>'name', 'Item') as name, sum(greatest(1, coalesce((e->>'qty')::int, 1)))::int as units
          from cancelled c cross join lateral jsonb_array_elements(coalesce(c.items, '[]'::jsonb)) e
          left join public.menu_items mi on mi.id::text = e->>'menuItemId'
          where not coalesce((e->>'isAddon')::boolean, false)
          group by 1 order by 2 desc limit 10) x)),
    'customers', jsonb_build_object(
      'new', (select count(*) from cust_first where first_day between p_from and p_to)::int,
      'returning', (select count(*) from cust_in ci join cust_first cf using (customer_id) where cf.first_day < p_from)::int,
      'inactive', (select count(*) from cust_first cf where cf.first_day < p_from
                    and not exists (select 1 from cust_in ci where ci.customer_id = cf.customer_id))::int),
    'orders', (select coalesce(jsonb_agg(jsonb_build_object(
        'order_number', order_number, 'date', to_char(local_ts, 'YYYY-MM-DD HH24:MI'), 'status', status,
        'payment', payment_method, 'payment_status', payment_status,
        'subtotal', subtotal, 'discount', discount, 'total', total, 'refund', coalesce(refund_amount, 0),
        'cancel_reason', cancel_reason) order by created_at), '[]'::jsonb)
      from (select * from o order by created_at limit 5000) x)
  ) into v_out;
  return v_out;
end $$;
revoke all on function public.store_sales_report(date, date) from public, anon;
grant execute on function public.store_sales_report(date, date) to authenticated;

-- ---------- Refunds ----------
create table if not exists public.refund_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  store_id uuid not null references public.stores (id) on delete cascade,
  customer_id uuid references public.profiles (id) on delete set null,
  amount numeric(10,2) not null check (amount > 0),
  kind text not null default 'full' check (kind in ('full', 'partial')),
  reason text not null check (char_length(reason) between 3 and 300),
  status text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'paid', 'failed')),
  requested_by uuid references public.profiles (id) on delete set null,
  requested_by_role text,
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  paid_at timestamptz,
  paystack_refund_reference text,
  failure_reason text,
  created_at timestamptz not null default now()
);
create index if not exists refund_requests_store_idx on public.refund_requests (store_id, created_at desc);
create index if not exists refund_requests_order_idx on public.refund_requests (order_id);
-- one open request per order at a time
create unique index if not exists refund_requests_one_open on public.refund_requests (order_id)
  where status in ('requested', 'approved');

alter table public.refund_requests enable row level security;
drop policy if exists "refunds: customer sees own" on public.refund_requests;
create policy "refunds: customer sees own" on public.refund_requests for select
  using (customer_id = auth.uid());
drop policy if exists "refunds: manager sees own shop" on public.refund_requests;
create policy "refunds: manager sees own shop" on public.refund_requests for select
  using (public.has_store_perm(store_id, 'process_refunds'));
drop policy if exists "refunds: developer sees all" on public.refund_requests;
create policy "refunds: developer sees all" on public.refund_requests for select
  using (public.current_role() = 'developer');
-- No insert/update/delete policies: every change goes through the functions below.

-- How much of an order can still be refunded.
create or replace function public.refundable_amount(p_order_id uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select greatest(0, o.total
    - coalesce(o.refund_amount, 0)
    - coalesce((select sum(amount) from public.refund_requests r where r.order_id = o.id and r.status in ('approved', 'paid')), 0))
  from public.orders o where o.id = p_order_id
$$;

create or replace function public.log_refund_action(p_req public.refund_requests, p_action text)
returns void language plpgsql security definer set search_path = public as $$
declare v_actor text; v_order text;
begin
  select coalesce(name, email) into v_actor from public.profiles where id = auth.uid();
  select order_number into v_order from public.orders where id = p_req.order_id;
  insert into public.audit_log (actor_id, actor_name, action, target_type, target_id, target_name, reason)
  values (auth.uid(), coalesce(v_actor, 'system'), p_action, 'refund', p_req.id,
          coalesce(v_order, 'order') || ' R' || to_char(p_req.amount, 'FM999990.00'),
          left(coalesce(p_req.decision_note, p_req.reason), 300));
end $$;

-- A customer asks for a refund on their own (collected / paid) order, or a manager starts one.
create or replace function public.request_refund(p_order_id uuid, p_amount numeric, p_reason text)
returns public.refund_requests
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_role text := public.current_role();
  v_left numeric;
  v_req public.refund_requests;
  v_staff boolean;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  v_staff := v_order.customer_id is distinct from auth.uid() and public.has_store_perm(v_order.store_id, 'process_refunds');
  if not (v_order.customer_id = auth.uid() or v_staff) then
    raise exception 'You can only request refunds for your own orders.';
  end if;
  if v_staff then perform public.assert_mfa_ok(); end if;
  if v_order.payment_method = 'card' and v_order.payment_status not in ('paid', 'refunded') then
    raise exception 'This order was not paid, so there is nothing to refund.';
  end if;
  if v_order.payment_method = 'cod' and v_order.status not in ('collected', 'delivered') then
    raise exception 'Cash orders can only be refunded after they were paid and collected.';
  end if;
  if exists (select 1 from public.refund_requests where order_id = p_order_id and status in ('requested', 'approved')) then
    raise exception 'There is already a refund request open for this order.';
  end if;
  v_left := public.refundable_amount(p_order_id);
  if v_left <= 0 then raise exception 'This order has already been fully refunded.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Please enter a refund amount.'; end if;
  if round(p_amount, 2) > v_left then
    raise exception 'The most that can be refunded on this order is R%.', to_char(v_left, 'FM999990.00');
  end if;
  if coalesce(char_length(trim(p_reason)), 0) < 3 then raise exception 'Please give a reason.'; end if;

  -- Staff starting a refund themselves are also the ones who approve it.
  insert into public.refund_requests (order_id, store_id, customer_id, amount, kind, reason, requested_by, requested_by_role,
                                      status, decided_by, decided_at)
  values (p_order_id, v_order.store_id, v_order.customer_id, round(p_amount, 2),
          case when round(p_amount, 2) >= v_left then 'full' else 'partial' end,
          left(trim(p_reason), 300), auth.uid(), v_role,
          case when v_staff then 'approved' else 'requested' end,
          case when v_staff then auth.uid() end,
          case when v_staff then now() end)
  returning * into v_req;
  perform public.log_refund_action(v_req, case when v_staff then 'refund_approved' else 'refund_requested' end);
  return v_req;
end $$;

-- The shop's manager approves (optionally a smaller amount) or rejects.
create or replace function public.decide_refund(p_request_id uuid, p_approve boolean, p_amount numeric default null, p_note text default null)
returns public.refund_requests
language plpgsql security definer set search_path = public as $$
declare
  v_req public.refund_requests;
  v_left numeric;
begin
  select * into v_req from public.refund_requests where id = p_request_id for update;
  if not found then raise exception 'Refund request not found.'; end if;
  perform public.assert_store_perm(v_req.store_id, 'process_refunds');
  if v_req.status <> 'requested' then raise exception 'This refund has already been decided.'; end if;

  if not p_approve then
    if coalesce(char_length(trim(p_note)), 0) < 3 then raise exception 'Please say why the refund is rejected.'; end if;
    update public.refund_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = left(trim(p_note), 300)
      where id = p_request_id returning * into v_req;
    perform public.log_refund_action(v_req, 'refund_rejected');
    return v_req;
  end if;

  v_left := public.refundable_amount(v_req.order_id);
  if coalesce(p_amount, v_req.amount) <= 0 or round(coalesce(p_amount, v_req.amount), 2) > v_left then
    raise exception 'The most that can be refunded on this order is R%.', to_char(v_left, 'FM999990.00');
  end if;
  update public.refund_requests
     set status = 'approved', amount = round(coalesce(p_amount, amount), 2),
         kind = case when round(coalesce(p_amount, amount), 2) >= v_left then 'full' else 'partial' end,
         decided_by = auth.uid(), decided_at = now(), decision_note = nullif(left(trim(coalesce(p_note, '')), 300), '')
   where id = p_request_id returning * into v_req;
  perform public.log_refund_action(v_req, 'refund_approved');
  return v_req;
end $$;

-- Cash order: the manager confirms the money was handed back.
-- Card orders are paid out by the process-refund Edge Function instead
-- (service role), which calls this with p_paystack_reference.
create or replace function public.mark_refund_paid(p_request_id uuid, p_paystack_reference text default null)
returns public.refund_requests
language plpgsql security definer set search_path = public as $$
declare
  v_req public.refund_requests;
  v_order public.orders;
begin
  select * into v_req from public.refund_requests where id = p_request_id for update;
  if not found then raise exception 'Refund request not found.'; end if;
  select * into v_order from public.orders where id = v_req.order_id;
  if auth.uid() is not null then          -- called by a person (cash refunds only)
    perform public.assert_store_perm(v_req.store_id, 'process_refunds');
    if v_order.payment_method = 'card' then
      raise exception 'Card refunds are paid back through Paystack automatically.';
    end if;
  end if;
  if v_req.status = 'paid' then return v_req; end if;
  if v_req.status <> 'approved' then raise exception 'Only approved refunds can be paid.'; end if;
  update public.refund_requests set status = 'paid', paid_at = now(), paystack_refund_reference = p_paystack_reference, failure_reason = null
    where id = p_request_id returning * into v_req;
  if public.refundable_amount(v_req.order_id) <= 0 and v_order.payment_method = 'card' then
    update public.orders set payment_status = 'refunded' where id = v_req.order_id;
  end if;
  if v_req.customer_id is not null then
    insert into public.notifications (user_id, message, type)
    values (v_req.customer_id, 'Your refund of R' || to_char(v_req.amount, 'FM999990.00') || ' for order ' || coalesce(v_order.order_number, '')
            || case when v_order.payment_method = 'card' then ' is on its way to your card. It can take a few days to show.' else ' has been paid.' end,
            'refund');
  end if;
  perform public.log_refund_action(v_req, 'refund_paid');
  return v_req;
end $$;

create or replace function public.mark_refund_failed(p_request_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.refund_requests set failure_reason = left(coalesce(p_reason, 'Unknown error'), 300)
   where id = p_request_id and status = 'approved';
end $$;

revoke all on function public.request_refund(uuid, numeric, text) from public, anon;
revoke all on function public.decide_refund(uuid, boolean, numeric, text) from public, anon;
revoke all on function public.mark_refund_paid(uuid, text) from public, anon;
revoke all on function public.mark_refund_failed(uuid, text) from public, anon, authenticated;
revoke all on function public.refundable_amount(uuid) from public, anon;
revoke all on function public.log_refund_action(public.refund_requests, text) from public, anon, authenticated;
grant execute on function public.request_refund(uuid, numeric, text) to authenticated;
grant execute on function public.decide_refund(uuid, boolean, numeric, text) to authenticated;
grant execute on function public.mark_refund_paid(uuid, text) to authenticated, service_role;
grant execute on function public.mark_refund_failed(uuid, text) to service_role;
grant execute on function public.refundable_amount(uuid) to authenticated, service_role;

-- ---------- Fix: card cancellations could never be saved ----------
-- paystack-cancel-order sets payment_status = 'refund_pending' after asking
-- Paystack for the refund, and paystack-webhook later sets 'refunded' or
-- 'refund_failed'. The old check only allowed pending/paid/failed/refunded,
-- so the save failed: the customer got their money back but the order
-- stayed 'received'. Allow the two refund states.
alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status = any (array['pending', 'paid', 'failed', 'refunded', 'refund_pending', 'refund_failed']));

-- Card refunds: lets process-refund claim a request so a double click can't
-- send two refunds to Paystack.
alter table public.refund_requests add column if not exists processing_started_at timestamptz;

-- ---------- Staff cancel (unpaid cash orders), with a reason ----------
create or replace function public.staff_cancel_order(p_order_id uuid, p_reason text, p_note text default null)
returns public.orders
language plpgsql security definer set search_path = public as $$
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
end $$;
revoke all on function public.staff_cancel_order(uuid, text, text) from public, anon;
grant execute on function public.staff_cancel_order(uuid, text, text) to authenticated;
