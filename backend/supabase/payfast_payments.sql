-- =========================================================================
-- CLICKFOOD — PayFast payments (replaces Paystack)
--
-- Keeps the existing checkout flow exactly as it is: a checkout_sessions
-- row is created before the customer pays, and the order is only created
-- by finalize_paystack_checkout() once the payment is confirmed on the
-- server. That function's name is kept (it isn't Paystack-specific inside
-- and other functions call it); only the gateway in front of it changes.
--
-- Adds:
--   * checkout_sessions.provider / environment / provider_payment_id /
--     cart_hash: which gateway and which PayFast environment (sandbox or
--     live) a payment belongs to, PayFast's own payment id (needed for
--     refunds and to spot a second payment for the same checkout), and a
--     fingerprint of the cart so repeated taps reuse one payment.
--     Existing rows are marked 'paystack' so history stays accurate.
--   * apply_payfast_payment(): the ONLY way a PayFast payment confirms a
--     checkout. Row-locked and idempotent: the same notification twice
--     does nothing; a second, separate payment for an already paid
--     checkout is recorded in payment_duplicates for a refund.
--   * payment_duplicates: second payments that are owed back.
--   * shop_payouts + shop_payout_balances() / record_shop_payout():
--     card money now goes to ClickFood's PayFast account, and ClickFood
--     pays each shop. Balances come from the payout_amount already saved
--     on every card order.
--
-- Nothing is deleted: Paystack columns (paystack_subaccount_code,
-- paystack_refund_reference, ...), payment_methods (saved cards, 0 rows)
-- and store_payout_accounts stay for history.
-- Rollback: supabase/payfast_payments_rollback.sql. Safe to run twice.
-- =========================================================================

-- ---------- checkout_sessions: gateway details ----------
alter table public.checkout_sessions add column if not exists provider text not null default 'paystack';
alter table public.checkout_sessions alter column provider set default 'payfast';
alter table public.checkout_sessions add column if not exists environment text;
alter table public.checkout_sessions add column if not exists provider_payment_id text;
alter table public.checkout_sessions add column if not exists cart_hash text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'checkout_sessions_provider_check') then
    alter table public.checkout_sessions add constraint checkout_sessions_provider_check check (provider in ('paystack', 'payfast'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'checkout_sessions_environment_check') then
    alter table public.checkout_sessions add constraint checkout_sessions_environment_check check (environment is null or environment in ('sandbox', 'live'));
  end if;
end $$;

-- one PayFast payment can only ever confirm one checkout
create unique index if not exists checkout_sessions_provider_payment_uidx
  on public.checkout_sessions (provider_payment_id) where provider_payment_id is not null;
-- finding the open payment for the same cart (repeat taps reuse it)
create index if not exists checkout_sessions_reuse_idx
  on public.checkout_sessions (customer_id, cart_hash) where status = 'pending';

-- ---------- second payments for the same checkout ----------
create table if not exists public.payment_duplicates (
  provider_payment_id text primary key,
  reference text not null,
  customer_id uuid references public.profiles(id) on delete set null,
  amount numeric(10,2) not null,
  environment text,
  status text not null default 'refund_due' check (status in ('refund_due', 'refunded', 'refund_failed')),
  refund_reference text,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payment_duplicates_customer_idx on public.payment_duplicates (customer_id);
alter table public.payment_duplicates enable row level security;
drop policy if exists "payment duplicates: developer read" on public.payment_duplicates;
create policy "payment duplicates: developer read" on public.payment_duplicates
  for select using (public.current_role() = 'developer');

-- ---------- applying a verified PayFast payment ----------
-- Called only by the payfast-itn Edge Function, AFTER it has checked the
-- signature, the merchant, the status and PayFast's own confirmation.
-- The amount is checked again here against the session's own amount.
create or replace function public.apply_payfast_payment(
  p_reference text, p_pf_payment_id text, p_amount numeric, p_environment text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare cs public.checkout_sessions; r jsonb;
begin
  select * into cs from public.checkout_sessions where reference = p_reference for update;
  if not found then return jsonb_build_object('error', 'unknown_reference'); end if;
  if cs.provider <> 'payfast' then return jsonb_build_object('error', 'not_a_payfast_payment'); end if;
  if cs.environment is distinct from p_environment then return jsonb_build_object('error', 'environment_mismatch'); end if;
  if coalesce(p_pf_payment_id, '') = '' then return jsonb_build_object('error', 'missing_payment_id'); end if;

  if round(p_amount, 2) <> round(cs.amount, 2) then
    if cs.status = 'pending' then perform public.mark_paystack_checkout_failed(p_reference, 'amount_mismatch'); end if;
    return jsonb_build_object('error', 'amount_mismatch', 'customer_id', cs.customer_id);
  end if;

  if cs.provider_payment_id is not null and cs.provider_payment_id <> p_pf_payment_id then
    -- a second, separate payment for a checkout that was already paid
    insert into public.payment_duplicates (provider_payment_id, reference, customer_id, amount, environment)
    values (p_pf_payment_id, p_reference, cs.customer_id, p_amount, p_environment)
    on conflict (provider_payment_id) do nothing;
    insert into public.notifications (user_id, message, type)
    values (cs.customer_id, 'We received a second payment of R' || to_char(p_amount, 'FM999990.00') || ' for the same order. It will be refunded.', 'refund');
    return jsonb_build_object('duplicate', true, 'provider_payment_id', p_pf_payment_id, 'customer_id', cs.customer_id);
  end if;

  if cs.provider_payment_id is null then
    update public.checkout_sessions set provider_payment_id = p_pf_payment_id, updated_at = now() where reference = p_reference;
  end if;
  -- creates the order(s), or for a group share applies the share; returns
  -- the earlier result unchanged if this payment was already applied
  r := public.finalize_paystack_checkout(p_reference);
  return coalesce(r, '{}'::jsonb) || jsonb_build_object('applied', true, 'customer_id', cs.customer_id);
end $$;

revoke all on function public.apply_payfast_payment(text, text, numeric, text) from public, anon, authenticated;
grant execute on function public.apply_payfast_payment(text, text, numeric, text) to service_role;

-- The wording a manager sees when trying to mark a card refund by hand.
create or replace function public.mark_refund_paid(p_request_id uuid, p_paystack_reference text default null)
returns public.refund_requests
language plpgsql security definer set search_path = public
as $$
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
      raise exception 'Card refunds are sent back through PayFast from the Refunds tab.';
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

-- ---------- shop payouts (ClickFood pays each shop) ----------
create table if not exists public.shop_payouts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete restrict,
  amount numeric(10,2) not null check (amount > 0),
  note text,
  paid_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists shop_payouts_store_idx on public.shop_payouts (store_id);
create index if not exists shop_payouts_paid_by_idx on public.shop_payouts (paid_by);
alter table public.shop_payouts enable row level security;
drop policy if exists "shop payouts: developer read" on public.shop_payouts;
create policy "shop payouts: developer read" on public.shop_payouts
  for select using (public.current_role() = 'developer');
drop policy if exists "shop payouts: own shop read" on public.shop_payouts;
create policy "shop payouts: own shop read" on public.shop_payouts
  for select using (store_id = public.current_store_id() and public.current_role() in ('manager', 'kitchen'));

-- What each shop has earned from PayFast card orders, what ClickFood has
-- paid it, and what is still owed. Earned = the shop's share already
-- saved on every paid card order (payout_amount), minus any card refunds.
create or replace function public.shop_payout_balances()
returns table (store_id uuid, store_name text, earned numeric, paid numeric, owed numeric, last_paid_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
begin
  if public.current_role() <> 'developer' then raise exception 'Developer access only.'; end if;
  return query
  with earned as (
    select o.store_id, sum(coalesce(o.payout_amount, 0) - coalesce(o.refund_amount, 0)) as amt
      from public.orders o
      join public.checkout_sessions cs on cs.reference = o.payment_reference and cs.provider = 'payfast'
     where o.payment_method = 'card' and o.payment_status in ('paid', 'refund_pending', 'refunded')
       and o.status <> 'cancelled'
     group by o.store_id
  ), paid as (
    select p.store_id, sum(p.amount) as amt, max(p.created_at) as last_at from public.shop_payouts p group by p.store_id
  )
  select s.id, s.name, round(coalesce(e.amt, 0), 2), round(coalesce(p.amt, 0), 2),
         round(coalesce(e.amt, 0) - coalesce(p.amt, 0), 2), p.last_at
    from public.stores s
    left join earned e on e.store_id = s.id
    left join paid p on p.store_id = s.id
   where coalesce(e.amt, 0) <> 0 or coalesce(p.amt, 0) <> 0
   order by 5 desc;
end $$;
revoke all on function public.shop_payout_balances() from public, anon;
grant execute on function public.shop_payout_balances() to authenticated;

create or replace function public.record_shop_payout(p_store uuid, p_amount numeric, p_note text default null)
returns public.shop_payouts
language plpgsql security definer set search_path = public
as $$
declare r public.shop_payouts;
begin
  if public.current_role() <> 'developer' then raise exception 'Developer access only.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount above R0.'; end if;
  if not exists (select 1 from public.stores where id = p_store) then raise exception 'Shop not found.'; end if;
  insert into public.shop_payouts (store_id, amount, note, paid_by)
  values (p_store, round(p_amount, 2), nullif(left(trim(coalesce(p_note, '')), 200), ''), auth.uid())
  returning * into r;
  return r;
end $$;
revoke all on function public.record_shop_payout(uuid, numeric, text) from public, anon;
grant execute on function public.record_shop_payout(uuid, numeric, text) to authenticated;

-- ---------- RecessBox payments (through the recessbox-payfast bridge) ----------
-- RecessBox takes card payments through ClickFood's PayFast account, so
-- its key never leaves ClickFood. PayFast has no "look up a payment" call
-- for these, so the verified notification is recorded here and RecessBox
-- reads the result through the signed bridge. Server-only: RLS on, no
-- policies.
create table if not exists public.bridge_payments (
  reference text primary key check (reference ~ '^rb_[A-Za-z0-9_-]{8,80}$'),
  app text not null default 'recessbox',
  booking_id text,
  booking_code text,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'ZAR',
  environment text not null check (environment in ('sandbox', 'live')),
  status text not null default 'pending' check (status in ('pending', 'success', 'failed')),
  provider_payment_id text unique,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.bridge_payments enable row level security;
