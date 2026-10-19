-- =========================================================================
-- CLICKFOOD — undo supabase/payfast_payments.sql
--
-- Only for going back to Paystack. Removes what that file added. The
-- payment_duplicates and shop_payouts tables are kept if they hold rows
-- (money records are never thrown away by a script); drop them by hand
-- once they are settled. Columns added to checkout_sessions stay: they
-- are harmless to Paystack and hold the PayFast payment ids.
-- =========================================================================
drop function if exists public.apply_payfast_payment(text, text, numeric, text);
drop function if exists public.shop_payout_balances();
drop function if exists public.record_shop_payout(uuid, numeric, text);

do $$ begin
  if not exists (select 1 from public.payment_duplicates) then drop table public.payment_duplicates; end if;
  if not exists (select 1 from public.shop_payouts) then drop table public.shop_payouts; end if;
end $$;

alter table public.checkout_sessions alter column provider set default 'paystack';

-- original wording
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
  if auth.uid() is not null then
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

do $$ begin
  if not exists (select 1 from public.bridge_payments) then drop table public.bridge_payments; end if;
end $$;
