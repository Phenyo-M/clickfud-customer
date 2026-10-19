-- =========================================================================
-- Group orders: who pays
--   leader : the leader pays for everyone in one checkout (the existing flow)
--   each   : everyone pays their own share with their own Paystack payment;
--            the shop gets ONE combined order once every share is paid.
--
-- Money rules
--   * Prices are worked out here from the live menu, never from the app.
--   * A share is only marked paid by finalize_paystack_checkout(), which runs
--     server-side after Paystack confirms the payment (paystack-verify or the
--     signed webhook). Nobody can write share rows directly.
--   * The group row is locked while a payment is applied, so two people paying
--     at the same moment can never create two shop orders.
--   * Paid shares are never deleted. If a group is cancelled after some people
--     paid, their shares become refund_pending and are refunded through
--     Paystack (paystack-group-refund); every step is in group_order_events.
--
-- Builds on customer_tools.sql. Safe to run more than once.
-- =========================================================================

-- ---------- invite codes: strong randomness ----------
create or replace function public.new_invite_code(p_prefix text)
returns text language plpgsql volatile as $$
declare
  chars text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  b bytea := decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex');
  v text := '';
begin
  for i in 0..5 loop v := v || substr(chars, 1 + (get_byte(b, i) % length(chars)), 1); end loop;
  return p_prefix || '-' || v;
end $$;

-- ---------- group columns ----------
alter table public.group_orders add column if not exists pay_mode text not null default 'leader';
alter table public.group_orders add column if not exists pay_deadline timestamptz;
alter table public.group_orders add column if not exists awaiting_at timestamptz;
alter table public.group_orders drop constraint if exists group_orders_pay_mode_check;
alter table public.group_orders add constraint group_orders_pay_mode_check check (pay_mode in ('leader', 'each'));
alter table public.group_orders drop constraint if exists group_orders_status_check;
alter table public.group_orders add constraint group_orders_status_check
  check (status in ('open', 'locked', 'awaiting_payment', 'placed', 'cancelled'));

-- ---------- each person's share ----------
create table if not exists public.group_order_shares (
  group_id uuid not null references public.group_orders (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  display_name text not null,
  items jsonb not null,
  amount numeric(10,2) not null check (amount > 0),
  platform_fee numeric(10,2) not null default 0,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'paid', 'failed', 'cancelled', 'refund_pending', 'refunded', 'refund_failed')),
  reference text unique,           -- the Paystack reference currently in use
  auth_url text,                   -- Paystack page for that reference (reused on retry, never a new charge)
  paid_reference text,
  paid_at timestamptz,
  refund_reference text,
  refunded_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists group_order_shares_user_idx on public.group_order_shares (user_id);
alter table public.group_order_shares enable row level security;
drop policy if exists "shares: own or leader" on public.group_order_shares;
create policy "shares: own or leader" on public.group_order_shares for select
  using (user_id = auth.uid() or exists (select 1 from public.group_orders g where g.id = group_id and g.leader_id = auth.uid()));
-- no insert/update/delete policies: only the functions below change shares

-- a second, unexpected payment for a share that was already paid (e.g. two tabs)
create table if not exists public.group_share_extra_payments (
  reference text primary key,
  group_id uuid not null references public.group_orders (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  amount numeric(10,2) not null,
  status text not null default 'refund_pending' check (status in ('refund_pending', 'refunded', 'refund_failed')),
  refund_reference text,
  created_at timestamptz not null default now()
);
alter table public.group_share_extra_payments enable row level security;   -- server only

-- ---------- history ----------
create table if not exists public.group_order_events (
  id bigserial primary key,
  group_id uuid not null references public.group_orders (id) on delete cascade,
  actor_id uuid,
  kind text not null,
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists group_order_events_group_idx on public.group_order_events (group_id, created_at);
alter table public.group_order_events enable row level security;
drop policy if exists "group events: members read" on public.group_order_events;
create policy "group events: members read" on public.group_order_events for select using (public.is_group_member(group_id));

-- ---------- join attempts (stops code guessing) ----------
create table if not exists public.group_join_attempts (
  user_id uuid not null,
  at timestamptz not null default now()
);
create index if not exists group_join_attempts_idx on public.group_join_attempts (user_id, at);
alter table public.group_join_attempts enable row level security;   -- server only

-- ---------- card payments linked to a group share ----------
alter table public.checkout_sessions add column if not exists group_id uuid references public.group_orders (id) on delete set null;
alter table public.checkout_sessions add column if not exists share_user_id uuid;

-- ---------- helpers ----------
create or replace function public.group_log(p_group uuid, p_kind text, p_detail text default null)
returns void language sql security definer set search_path = public as $$
  insert into public.group_order_events (group_id, actor_id, kind, detail) values (p_group, auth.uid(), p_kind, p_detail);
$$;

create or replace function public.group_notify(p_group uuid, p_message text, p_except uuid default null)
returns void language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, message, type)
  select m.user_id, p_message, 'group_order' from public.group_order_members m
   where m.group_id = p_group and m.user_id is distinct from p_except;
$$;

-- Prices one person's food in a group from the live menu: the same rules as
-- paystack-initialize (item price + the platform's per-item fee + extras).
-- Returns { lines, amount, platform_fee }, or raises if something can't be ordered.
create or replace function public.group_price_member(p_group uuid, p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  g public.group_orders;
  r record;
  v_lines jsonb := '[]'::jsonb;
  v_amount numeric := 0;
  v_fee numeric := 0;
  v_extras jsonb;
  v_extras_total numeric;
  v_price numeric;
  v_name text;
begin
  select * into g from public.group_orders where id = p_group;
  select display_name into v_name from public.group_order_members where group_id = p_group and user_id = p_user;
  for r in
    select gi.*, mi.name as item_name, mi.price as base_price, coalesce(mi.platform_fee_amount, 0) as fee_unit,
           mi.image, mi.available, mi.status as item_status, mi.store_id as item_store
      from public.group_order_items gi join public.menu_items mi on mi.id = gi.menu_item_id
     where gi.group_id = p_group and gi.user_id = p_user
     order by gi.created_at
  loop
    if r.item_store <> g.store_id or r.item_status <> 'approved' or not r.available then
      raise exception '"%" is no longer available. % needs to remove it.', r.item_name, coalesce(v_name, 'Someone');
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('id', x.extra_id, 'name', x.name, 'price', round(x.price, 2)) order by x.name), '[]'::jsonb),
           coalesce(sum(round(x.price, 2)), 0)
      into v_extras, v_extras_total
      from public.menu_item_extras_public x
     where x.menu_item_id = r.menu_item_id and x.store_id = g.store_id and x.extra_id = any (r.addon_ids);
    if jsonb_array_length(v_extras) <> coalesce(array_length(r.addon_ids, 1), 0) then
      raise exception 'An extra on "%" is no longer available. % needs to change it.', r.item_name, coalesce(v_name, 'Someone');
    end if;
    v_price := round(r.base_price + r.fee_unit + v_extras_total, 2);
    v_lines := v_lines || jsonb_build_object(
      'menuItemId', r.menu_item_id, 'name', r.item_name, 'price', v_price, 'qty', r.qty, 'image', r.image,
      'addons', v_extras, 'isAddon', false,
      'specialInstructions', left('Group ' || g.code || ' · For ' || coalesce(v_name, 'Friend') || coalesce(' · ' || r.note, ''), 200));
    v_amount := v_amount + v_price * r.qty;
    v_fee := v_fee + round(r.fee_unit, 2) * r.qty;
  end loop;
  return jsonb_build_object('lines', v_lines, 'amount', round(v_amount, 2), 'platform_fee', round(v_fee, 2));
end $$;

-- Checks the whole group can be ordered right now (shop open, items on sale, stock).
create or replace function public.group_check_orderable(p_group uuid)
returns void language plpgsql stable security definer set search_path = public as $$
declare g public.group_orders; v_reason text; v_ids uuid[]; r record;
begin
  select * into g from public.group_orders where id = p_group;
  if not exists (select 1 from public.stores where id = g.store_id and status = 'approved' and is_published) then
    raise exception 'This shop is not taking orders right now.';
  end if;
  select array_agg(distinct menu_item_id) into v_ids from public.group_order_items where group_id = p_group;
  if v_ids is null then raise exception 'Nobody has added any food yet.'; end if;
  v_reason := public.ordering_block_reason(g.store_id, v_ids);
  if v_reason is not null then raise exception '%', v_reason; end if;
  for r in select mi.name, mi.stock, sum(gi.qty) as want
             from public.group_order_items gi join public.menu_items mi on mi.id = gi.menu_item_id
            where gi.group_id = p_group group by mi.id, mi.name, mi.stock
  loop
    if r.stock is not null and r.stock < r.want then
      raise exception 'Only % left of "%". Someone needs to order fewer.', r.stock, r.name;
    end if;
  end loop;
end $$;

-- ---------- create / join ----------
drop function if exists public.create_group_order(uuid, text);
create or replace function public.create_group_order(p_store_id uuid, p_title text default null, p_pay_mode text default 'leader')
returns public.group_orders
language plpgsql security definer set search_path = public as $$
declare v public.group_orders; v_code text;
begin
  if auth.uid() is null then raise exception 'Please sign in.'; end if;
  if p_pay_mode not in ('leader', 'each') then raise exception 'Choose who pays.'; end if;
  if not exists (select 1 from public.stores where id = p_store_id and status = 'approved' and is_published) then
    raise exception 'That shop isn''t available.';
  end if;
  if (select count(*) from public.group_orders where leader_id = auth.uid() and status in ('open', 'locked', 'awaiting_payment') and expires_at > now()) >= 3 then
    raise exception 'You already have 3 group orders going. Finish or cancel one first.';
  end if;
  loop
    v_code := public.new_invite_code('G');
    exit when not exists (select 1 from public.group_orders where code = v_code);
  end loop;
  insert into public.group_orders (code, leader_id, store_id, title, pay_mode)
  values (v_code, auth.uid(), p_store_id, nullif(left(trim(coalesce(p_title, '')), 60), ''), p_pay_mode)
  returning * into v;
  insert into public.group_order_members (group_id, user_id, display_name) values (v.id, auth.uid(), public.first_name_of(auth.uid()));
  perform public.group_log(v.id, 'created', p_pay_mode);
  return v;
end $$;

create or replace function public.join_group_order(p_code text)
returns public.group_orders
language plpgsql security definer set search_path = public as $$
declare v public.group_orders; v_name text;
begin
  if auth.uid() is null then raise exception 'Please sign in.'; end if;
  if (select count(*) from public.group_join_attempts where user_id = auth.uid() and at > now() - interval '10 minutes') >= 10 then
    raise exception 'Too many wrong codes. Please wait a few minutes and try again.';
  end if;
  select * into v from public.group_orders where code = upper(trim(p_code));
  if not found then
    -- recorded and answered with "nothing" (not an error, which would undo the
    -- record): the app shows "that code doesn't exist"
    insert into public.group_join_attempts (user_id) values (auth.uid());
    return null;
  end if;
  if public.is_group_member(v.id) then return v; end if;
  if v.status <> 'open' or v.expires_at <= now() then raise exception 'This group order is closed. Ask the leader to start a new one.'; end if;
  if (select count(*) from public.group_order_members where group_id = v.id) >= 15 then raise exception 'This group is full (15 people).'; end if;
  v_name := public.first_name_of(auth.uid());
  insert into public.group_order_members (group_id, user_id, display_name) values (v.id, auth.uid(), v_name);
  perform public.group_log(v.id, 'joined', v_name);
  insert into public.notifications (user_id, message, type) values (v.leader_id, v_name || ' joined your group order ' || v.code || '.', 'group_order');
  return v;
end $$;

-- the leader can change who pays only while the group is still open (nothing is paid yet)
create or replace function public.set_group_pay_mode(p_group uuid, p_pay_mode text)
returns public.group_orders
language plpgsql security definer set search_path = public as $$
declare v public.group_orders;
begin
  select * into v from public.group_orders where id = p_group for update;
  if not found or v.leader_id is distinct from auth.uid() then raise exception 'Only the group leader can do this.'; end if;
  if p_pay_mode not in ('leader', 'each') then raise exception 'Choose who pays.'; end if;
  if v.status <> 'open' then raise exception 'Reopen the group before changing who pays.'; end if;
  update public.group_orders set pay_mode = p_pay_mode where id = p_group returning * into v;
  perform public.group_log(p_group, 'pay_mode', p_pay_mode);
  return v;
end $$;

-- ---------- leader actions ----------
-- lock          leader pays: stop changes, leader checks out
--               each pays:   stop changes, work out every share, ask everyone to pay
-- unlock        reopen for changes (each pays: only while nobody has paid)
-- extend        each pays: move the payment deadline (p_minutes)
-- drop_unpaid   each pays: remove people who haven't paid, and their food
-- cancel        end it; anyone who already paid is refunded
drop function if exists public.set_group_order_state(uuid, text);
create or replace function public.set_group_order_state(p_group uuid, p_action text, p_minutes int default null)
returns public.group_orders
language plpgsql security definer set search_path = public as $$
declare v public.group_orders; mem record; pr jsonb; v_shop text; v_dropped text;
begin
  select * into v from public.group_orders where id = p_group for update;
  if not found then raise exception 'Group order not found.'; end if;
  if v.leader_id is distinct from auth.uid() then raise exception 'Only the group leader can do this.'; end if;
  if v.status = 'placed' then raise exception 'This group order has already been sent to the shop.'; end if;
  if v.status = 'cancelled' then raise exception 'This group order was cancelled.'; end if;
  select name into v_shop from public.stores where id = v.store_id;

  if p_action = 'lock' then
    if v.status in ('locked', 'awaiting_payment') then return v; end if;
    perform public.group_check_orderable(p_group);
    if v.pay_mode = 'leader' then
      update public.group_orders set status = 'locked', locked_at = now() where id = p_group returning * into v;
      perform public.group_log(p_group, 'locked');
      perform public.group_notify(p_group, 'Group order ' || v.code || ' is locked. The leader is paying for everyone.', auth.uid());
    else
      delete from public.group_order_shares where group_id = p_group;
      for mem in select distinct gi.user_id, gm.display_name from public.group_order_items gi
                 join public.group_order_members gm on gm.group_id = gi.group_id and gm.user_id = gi.user_id
                where gi.group_id = p_group
      loop
        pr := public.group_price_member(p_group, mem.user_id);
        insert into public.group_order_shares (group_id, user_id, display_name, items, amount, platform_fee)
        values (p_group, mem.user_id, mem.display_name, pr->'lines', (pr->>'amount')::numeric, (pr->>'platform_fee')::numeric);
        insert into public.notifications (user_id, message, type)
        values (mem.user_id, 'Pay your share of group order ' || v.code || ': R' || to_char((pr->>'amount')::numeric, 'FM999990.00') || '.', 'group_order');
      end loop;
      update public.group_orders
         set status = 'awaiting_payment', locked_at = now(), awaiting_at = now(),
             pay_deadline = now() + make_interval(mins => greatest(5, least(coalesce(p_minutes, 30), 240))),
             expires_at = greatest(expires_at, now() + interval '24 hours')
       where id = p_group returning * into v;
      perform public.group_log(p_group, 'awaiting_payment');
    end if;

  elsif p_action = 'unlock' then
    if v.status = 'open' then return v; end if;
    if exists (select 1 from public.group_order_shares where group_id = p_group and status in ('processing', 'paid', 'refund_pending', 'refunded', 'refund_failed')) then
      raise exception 'Someone has already paid or is paying, so the group can''t be reopened. You can remove people who haven''t paid, or cancel.';
    end if;
    delete from public.group_order_shares where group_id = p_group;
    update public.group_orders set status = 'open', locked_at = null, awaiting_at = null, pay_deadline = null,
           expires_at = greatest(expires_at, now() + interval '1 hour') where id = p_group returning * into v;
    perform public.group_log(p_group, 'reopened');
    perform public.group_notify(p_group, 'Group order ' || v.code || ' is open again. You can change your food.', auth.uid());

  elsif p_action = 'extend' then
    if v.status <> 'awaiting_payment' then raise exception 'There is no payment deadline to change.'; end if;
    update public.group_orders
       set pay_deadline = greatest(coalesce(pay_deadline, now()), now()) + make_interval(mins => greatest(5, least(coalesce(p_minutes, 15), 240)))
     where id = p_group returning * into v;
    perform public.group_log(p_group, 'deadline_extended', p_minutes::text);
    insert into public.notifications (user_id, message, type)
    select s.user_id, 'More time to pay for group order ' || v.code || '.', 'group_order'
      from public.group_order_shares s where s.group_id = p_group and s.status in ('pending', 'failed', 'cancelled');

  elsif p_action = 'drop_unpaid' then
    if v.status <> 'awaiting_payment' then raise exception 'Only possible while waiting for payments.'; end if;
    if exists (select 1 from public.group_order_shares where group_id = p_group and status = 'processing' and updated_at > now() - interval '15 minutes') then
      raise exception 'Someone is paying right now. Try again in a few minutes.';
    end if;
    if not exists (select 1 from public.group_order_shares where group_id = p_group and status = 'paid') then
      raise exception 'Nobody has paid yet. Cancel the group instead.';
    end if;
    select string_agg(display_name, ', ') into v_dropped from public.group_order_shares
     where group_id = p_group and status in ('pending', 'failed', 'cancelled', 'processing');
    insert into public.notifications (user_id, message, type)
    select s.user_id, 'You were removed from group order ' || v.code || ' because your share wasn''t paid in time.', 'group_order'
      from public.group_order_shares s where s.group_id = p_group and s.status in ('pending', 'failed', 'cancelled', 'processing');
    delete from public.group_order_items i using public.group_order_shares s
     where i.group_id = p_group and s.group_id = p_group and s.user_id = i.user_id and s.status in ('pending', 'failed', 'cancelled', 'processing');
    delete from public.group_order_members m using public.group_order_shares s
     where m.group_id = p_group and s.group_id = p_group and s.user_id = m.user_id and m.user_id <> v.leader_id
       and s.status in ('pending', 'failed', 'cancelled', 'processing');
    delete from public.group_order_shares where group_id = p_group and status in ('pending', 'failed', 'cancelled', 'processing');
    perform public.group_log(p_group, 'dropped_unpaid', v_dropped);
    -- everyone left has paid: send it to the shop
    perform public.group_place_combined(p_group);
    select * into v from public.group_orders where id = p_group;

  elsif p_action = 'cancel' then
    update public.group_order_shares set status = 'refund_pending', updated_at = now()
     where group_id = p_group and status = 'paid';
    update public.group_order_shares set status = 'cancelled', updated_at = now()
     where group_id = p_group and status in ('pending', 'failed', 'processing');
    update public.group_orders set status = 'cancelled' where id = p_group returning * into v;
    perform public.group_log(p_group, 'cancelled');
    perform public.group_notify(p_group, 'Group order ' || v.code || ' was cancelled.'
      || case when exists (select 1 from public.group_order_shares where group_id = p_group and status = 'refund_pending')
              then ' Anyone who paid is being refunded.' else '' end, auth.uid());
  else
    raise exception 'Unknown action.';
  end if;
  return v;
end $$;

-- ---------- one combined order for the shop ----------
-- Runs with the group row already locked. Only acts when every share is paid.
create or replace function public.group_place_combined(p_group uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  g public.group_orders;
  v_lines jsonb := '[]'::jsonb; v_total numeric := 0; v_fee numeric := 0;
  v_sub text; v_order public.orders; s record;
begin
  select * into g from public.group_orders where id = p_group;
  if g.status <> 'awaiting_payment' then return null; end if;
  if not exists (select 1 from public.group_order_shares where group_id = p_group) then return null; end if;
  if exists (select 1 from public.group_order_shares where group_id = p_group and status <> 'paid') then return null; end if;
  for s in select * from public.group_order_shares where group_id = p_group order by created_at, display_name loop
    v_lines := v_lines || s.items;
    v_total := v_total + s.amount;
    v_fee := v_fee + s.platform_fee;
  end loop;
  select paystack_subaccount_code into v_sub from public.store_payout_accounts where store_id = g.store_id;
  -- The money is already confirmed by Paystack: create the order as a server
  -- action (the same as a normal paid card order), so the ordering-hours and
  -- deal checks meant for unpaid orders placed by a person don't apply.
  perform set_config('request.jwt.claims', '', true);
  insert into public.orders (
    customer_id, store_id, items, subtotal, delivery_fee, discount, promo_code, total,
    payment_method, payment_status, payment_reference, delivery_location, status, status_history,
    paystack_subaccount_code, payout_amount, platform_fee_amount
  ) values (
    g.leader_id, g.store_id, v_lines, round(v_total, 2), 0, 0, null, round(v_total, 2),
    'card', 'paid', null,
    jsonb_build_object('fulfilment', 'collection', 'group_code', g.code, 'group_pay', 'each', 'group_id', g.id),
    'preparing',
    jsonb_build_array(jsonb_build_object('status', 'received', 'at', now()), jsonb_build_object('status', 'preparing', 'at', now())),
    v_sub, round(v_total - least(v_fee, v_total), 2), round(least(v_fee, v_total), 2)
  ) returning * into v_order;
  update public.group_orders set status = 'placed', placed_at = now(), order_ids = array[v_order.id] where id = p_group;
  perform public.group_log(p_group, 'placed', coalesce(v_order.order_number, v_order.id::text));
  perform public.group_notify(p_group, 'Everyone paid. Group order ' || g.code || ' was sent to the shop as order ' || coalesce(v_order.order_number, '') || '.');
  return v_order.id;
end $$;

-- ---------- payments (called by Edge Functions with the service key only) ----------
-- Start (or reuse) a payment for one person's share. Row-locked, so double taps
-- or two tabs can't start two payments at once.
create or replace function public.claim_group_share_payment(p_group uuid, p_user uuid, p_reference text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare g public.group_orders; s public.group_order_shares;
begin
  select * into g from public.group_orders where id = p_group;
  if not found then return jsonb_build_object('error', 'Group order not found.'); end if;
  select * into s from public.group_order_shares where group_id = p_group and user_id = p_user for update;
  if not found then return jsonb_build_object('error', 'You have nothing to pay in this group.'); end if;
  if s.status = 'paid' then return jsonb_build_object('paid', true); end if;
  if g.status <> 'awaiting_payment' then return jsonb_build_object('error', 'This group isn''t taking payments.'); end if;
  if s.status = 'processing' and s.updated_at > now() - interval '2 minutes' and s.auth_url is null then
    return jsonb_build_object('error', 'Your payment is starting. Try again in a moment.');
  end if;
  if s.status not in ('pending', 'failed', 'cancelled', 'processing') then
    return jsonb_build_object('error', 'This share can''t be paid.');
  end if;
  update public.group_order_shares
     set status = 'processing', reference = p_reference, auth_url = null, failure_reason = null, updated_at = now()
   where group_id = p_group and user_id = p_user returning * into s;
  return jsonb_build_object('claimed', true, 'amount', s.amount, 'platform_fee', s.platform_fee, 'items', s.items, 'store_id', g.store_id, 'code', g.code);
end $$;

create or replace function public.set_share_auth_url(p_group uuid, p_user uuid, p_reference text, p_url text)
returns void language sql security definer set search_path = public as $$
  update public.group_order_shares set auth_url = p_url, updated_at = now()
   where group_id = p_group and user_id = p_user and reference = p_reference;
$$;

-- Applies a confirmed Paystack payment to a share. Called from
-- finalize_paystack_checkout (below). Idempotent.
create or replace function public.finalize_group_share(p_reference text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cs public.checkout_sessions; g public.group_orders; s public.group_order_shares; v_order uuid;
begin
  select * into cs from public.checkout_sessions where reference = p_reference for update;
  if not found then raise exception 'Unknown checkout session.'; end if;
  if cs.status = 'paid' then
    select * into s from public.group_order_shares where group_id = cs.group_id and user_id = cs.share_user_id;
    return jsonb_build_object('order_ids', cs.order_ids, 'group_id', cs.group_id, 'share_status', s.status, 'already', true);
  end if;
  select * into g from public.group_orders where id = cs.group_id for update;       -- one payment applied at a time per group
  select * into s from public.group_order_shares where group_id = cs.group_id and user_id = cs.share_user_id for update;
  update public.checkout_sessions set status = 'paid', updated_at = now() where reference = p_reference;

  if s.group_id is null then
    -- the share no longer exists (they were removed): refund this payment in full
    insert into public.group_share_extra_payments (reference, group_id, user_id, amount) values (p_reference, cs.group_id, cs.share_user_id, cs.amount)
    on conflict do nothing;
    perform public.group_log(cs.group_id, 'payment_without_share', p_reference);
    return jsonb_build_object('order_ids', '[]'::jsonb, 'group_id', cs.group_id, 'share_status', 'removed', 'refund_reference', p_reference);
  end if;

  if s.status in ('paid', 'refund_pending', 'refunded', 'refund_failed') then
    -- already paid with another payment: this one is a duplicate, refund it
    insert into public.group_share_extra_payments (reference, group_id, user_id, amount) values (p_reference, s.group_id, s.user_id, cs.amount)
    on conflict do nothing;
    perform public.group_log(s.group_id, 'duplicate_payment', p_reference);
    return jsonb_build_object('order_ids', '[]'::jsonb, 'group_id', s.group_id, 'share_status', s.status, 'refund_reference', p_reference);
  end if;

  if g.status = 'cancelled' then
    update public.group_order_shares set status = 'refund_pending', paid_reference = p_reference, paid_at = now(), updated_at = now()
     where group_id = s.group_id and user_id = s.user_id;
    perform public.group_log(s.group_id, 'paid_after_cancel', s.display_name);
    return jsonb_build_object('order_ids', '[]'::jsonb, 'group_id', s.group_id, 'share_status', 'refund_pending', 'refund_group', true);
  end if;

  update public.group_order_shares set status = 'paid', paid_reference = p_reference, paid_at = now(), failure_reason = null, updated_at = now()
   where group_id = s.group_id and user_id = s.user_id;
  perform public.group_log(s.group_id, 'paid', s.display_name);
  insert into public.notifications (user_id, message, type)
  values (s.user_id, 'Payment received for group order ' || g.code || ': R' || to_char(s.amount, 'FM999990.00') || '.', 'group_order');
  if s.user_id <> g.leader_id then
    insert into public.notifications (user_id, message, type) values (g.leader_id, s.display_name || ' paid their share of ' || g.code || '.', 'group_order');
  end if;
  begin
    v_order := public.group_place_combined(s.group_id);
  exception when others then
    -- never lose a confirmed payment because the shop order couldn't be created
    -- (e.g. an item sold out meanwhile): keep the share paid, tell the leader
    v_order := null;
    perform public.group_log(s.group_id, 'place_failed', sqlerrm);
    insert into public.notifications (user_id, message, type)
    values (g.leader_id, 'Group order ' || g.code || ' couldn''t be sent to the shop: ' || sqlerrm || ' You can cancel it to refund everyone.', 'group_order');
  end;
  update public.checkout_sessions set order_ids = case when v_order is null then '[]'::jsonb else jsonb_build_array(v_order) end where reference = p_reference;
  return jsonb_build_object('order_ids', case when v_order is null then '[]'::jsonb else jsonb_build_array(v_order) end,
                            'group_id', s.group_id, 'share_status', 'paid', 'placed', v_order is not null);
end $$;

-- the existing card checkout finalizer, now aware of group shares
create or replace function public.finalize_paystack_checkout(p_reference text)
returns jsonb language plpgsql security definer set search_path = public as $function$
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

create or replace function public.mark_paystack_checkout_failed(p_reference text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare cs public.checkout_sessions;
begin
  update public.checkout_sessions
     set status = 'failed', failure_reason = coalesce(p_reason, failure_reason), updated_at = now()
   where reference = p_reference and status = 'pending'
  returning * into cs;
  if cs.group_id is not null then
    update public.group_order_shares
       set status = case when p_reason = 'abandoned' then 'cancelled' else 'failed' end,
           failure_reason = p_reason, auth_url = null, updated_at = now()
     where group_id = cs.group_id and user_id = cs.share_user_id and reference = p_reference and status = 'processing';
  end if;
end $$;

-- refunds (paystack-group-refund / paystack-webhook)
create or replace function public.mark_group_refund(p_reference text, p_refund_reference text, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('refund_pending', 'refunded', 'refund_failed') then raise exception 'bad status'; end if;
  update public.group_order_shares
     set status = p_status, refund_reference = coalesce(p_refund_reference, refund_reference),
         refunded_at = case when p_status = 'refunded' then now() else refunded_at end, updated_at = now()
   where paid_reference = p_reference and status in ('refund_pending', 'refund_failed', 'refunded');
  update public.group_share_extra_payments
     set status = p_status, refund_reference = coalesce(p_refund_reference, refund_reference)
   where reference = p_reference;
end $$;

-- ---------- what the app shows ----------
-- Everyone in the group sees the totals and their own share; the leader sees every share.
create or replace function public.group_payment_board(p_group uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare g public.group_orders; v_leader boolean; o record;
begin
  if not public.is_group_member(p_group) then return null; end if;
  select * into g from public.group_orders where id = p_group;
  v_leader := g.leader_id = auth.uid();
  select order_number, status into o from public.orders where id = any (g.order_ids) order by created_at limit 1;
  return jsonb_build_object(
    'pay_mode', g.pay_mode, 'status', g.status, 'pay_deadline', g.pay_deadline,
    'total', coalesce((select sum(amount) from public.group_order_shares where group_id = p_group), 0),
    'paid', coalesce((select sum(amount) from public.group_order_shares where group_id = p_group and status in ('paid', 'refund_pending', 'refunded', 'refund_failed')), 0),
    'people', (select count(*) from public.group_order_shares where group_id = p_group),
    'people_paid', (select count(*) from public.group_order_shares where group_id = p_group and status = 'paid'),
    'shares', coalesce((select jsonb_agg(jsonb_build_object(
                 'user_id', s.user_id, 'name', s.display_name, 'amount', s.amount, 'status', s.status,
                 'is_me', s.user_id = auth.uid(), 'items', case when s.user_id = auth.uid() then s.items end)
                 order by s.display_name)
               from public.group_order_shares s where s.group_id = p_group and (v_leader or s.user_id = auth.uid())), '[]'::jsonb),
    'order_number', o.order_number, 'order_status', o.status,
    'refunds_waiting', exists (select 1 from public.group_order_shares where group_id = p_group and status = 'refund_pending' and refund_reference is null)
  );
end $$;

-- the Group order page list: one row per group, with progress
create or replace function public.my_group_orders()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', g.id, 'code', g.code, 'title', g.title, 'status', g.status, 'pay_mode', g.pay_mode,
      'store_id', g.store_id, 'leader_id', g.leader_id, 'created_at', g.created_at, 'expires_at', g.expires_at,
      'leader_name', (select display_name from public.group_order_members where group_id = g.id and user_id = g.leader_id),
      'members', (select count(*) from public.group_order_members where group_id = g.id),
      'people', (select count(*) from public.group_order_shares where group_id = g.id),
      'people_paid', (select count(*) from public.group_order_shares where group_id = g.id and status = 'paid')
    ) x
    from public.group_orders g
    where public.is_group_member(g.id) and g.created_at > now() - interval '30 days'
    order by g.created_at desc limit 20
  ) t
$$;

-- leader pays: link the leader's normal checkout to the group (unchanged rules) and tell everyone
create or replace function public.attach_group_order(p_group uuid)
returns public.group_orders
language plpgsql security definer set search_path = public as $$
declare v public.group_orders; v_ids uuid[];
begin
  select * into v from public.group_orders where id = p_group for update;
  if not found or v.leader_id is distinct from auth.uid() then raise exception 'Group order not found.'; end if;
  if v.status = 'placed' then return v; end if;
  if v.status <> 'locked' then return v; end if;
  select array_agg(o.id order by o.created_at) into v_ids
    from public.orders o
   where o.customer_id = v.leader_id and o.store_id = v.store_id and o.created_at >= v.locked_at
     and exists (select 1 from jsonb_array_elements(o.items) e where e->>'specialInstructions' like '%' || v.code || '%');
  if v_ids is null then return v; end if;
  update public.group_orders set status = 'placed', placed_at = now(), order_ids = v_ids where id = p_group returning * into v;
  perform public.group_log(p_group, 'placed', 'leader paid');
  perform public.group_notify(p_group, 'The leader paid. Group order ' || v.code || ' was sent to the shop.', auth.uid());
  return v;
end $$;

-- ---------- permissions ----------
revoke all on function public.group_log(uuid, text, text) from public, anon, authenticated;
revoke all on function public.group_notify(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.group_price_member(uuid, uuid) from public, anon, authenticated;
revoke all on function public.group_check_orderable(uuid) from public, anon, authenticated;
revoke all on function public.group_place_combined(uuid) from public, anon, authenticated;
revoke all on function public.claim_group_share_payment(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.set_share_auth_url(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.finalize_group_share(text) from public, anon, authenticated;
revoke all on function public.finalize_paystack_checkout(text) from public, anon, authenticated;
revoke all on function public.mark_paystack_checkout_failed(text, text) from public, anon, authenticated;
revoke all on function public.mark_group_refund(text, text, text) from public, anon, authenticated;
grant execute on function public.claim_group_share_payment(uuid, uuid, text) to service_role;
grant execute on function public.set_share_auth_url(uuid, uuid, text, text) to service_role;
grant execute on function public.finalize_group_share(text) to service_role;
grant execute on function public.finalize_paystack_checkout(text) to service_role;
grant execute on function public.mark_paystack_checkout_failed(text, text) to service_role;
grant execute on function public.mark_group_refund(text, text, text) to service_role;

revoke all on function public.create_group_order(uuid, text, text) from public, anon;
revoke all on function public.set_group_pay_mode(uuid, text) from public, anon;
revoke all on function public.set_group_order_state(uuid, text, int) from public, anon;
revoke all on function public.group_payment_board(uuid) from public, anon;
revoke all on function public.my_group_orders() from public, anon;
grant execute on function public.create_group_order(uuid, text, text) to authenticated;
grant execute on function public.set_group_pay_mode(uuid, text) to authenticated;
grant execute on function public.set_group_order_state(uuid, text, int) to authenticated;
grant execute on function public.group_payment_board(uuid) to authenticated;
grant execute on function public.my_group_orders() to authenticated;
grant select on public.group_order_shares, public.group_order_events to authenticated;
