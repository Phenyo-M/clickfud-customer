-- =========================================================================
-- CLICKFOOD — security fixes, phase 1 (audit of 2026-10-02, findings 1-6,
-- 10, 11). See docs/database-audit-2026-10-02.md.
--
-- Only adds/replaces triggers, policies and grants. No data is changed or
-- deleted. Undo: supabase/security_phase1_rollback.sql (restores the exact
-- previous live definitions). Safe to run more than once.
-- =========================================================================

-- ---------- 1. Orders created by a person are unpaid cash orders ----------
-- Card orders are only ever created by the server (apply_payfast_payment ->
-- finalize_paystack_checkout, which runs with no signed-in user). An order
-- inserted through the app by a person can therefore only be a cash order
-- waiting for payment. Before this, a student could insert an order already
-- marked "paid by card" and "ready" without paying.
-- Runs first (trg_aa_...) so the pricing/rules triggers see clean values.
create or replace function public.guard_customer_order_insert()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then return new; end if;   -- the server / SQL editor
  if new.customer_id is distinct from auth.uid() then
    raise exception 'You can only place orders for yourself.' using errcode = '42501';
  end if;
  if coalesce(new.payment_method, 'cod') <> 'cod' then
    raise exception 'Card orders are created after payment is confirmed.' using errcode = '42501';
  end if;
  new.payment_method := 'cod';
  new.payment_status := 'pending';
  if new.status is null or new.status not in ('received', 'preparing') then new.status := 'preparing'; end if;
  -- only the server or the shop may set these
  new.payment_reference := null;
  new.paystack_subaccount_code := null;
  new.payout_amount := null;
  new.cancellation_fee_amount := null;
  new.refund_amount := null;
  new.refunded_at := null;
  new.paystack_refund_reference := null;
  new.cash_tendered := null;
  new.assigned_driver := null;
  new.collected_at := null;
  new.collected_by := null;
  new.collection_code := null;
  new.collection_token := null;
  new.ready_at := null;
  new.original_ready_at := null;
  new.collection_deadline := null;
  new.original_collection_deadline := null;
  new.collection_state := null;
  new.collection_expired_at := null;
  new.collection_response_deadline := null;
  new.rescheduled_for := null;
  new.rescheduled_at := null;
  new.reschedule_reason := null;
  new.reschedule_count := 0;
  new.released_at := null;
  new.needs_reprep := false;
  new.cancel_reason := null;
  new.cancel_note := null;
  new.priority := 'normal';
  new.eta := null;
  -- ClickFood's per-item fee, from the live menu (not from the app)
  select coalesce(sum(coalesce(mi.platform_fee_amount, 0) * greatest(1, coalesce((e->>'qty')::int, 1))), 0)
    into new.platform_fee_amount
    from jsonb_array_elements(coalesce(new.items, '[]'::jsonb)) e
    join public.menu_items mi on mi.id::text = e->>'menuItemId' and mi.store_id = new.store_id
   where not coalesce((e->>'isAddon')::boolean, false);
  return new;
end $$;

drop trigger if exists trg_aa_guard_customer_order_insert on public.orders;
create trigger trg_aa_guard_customer_order_insert
  before insert on public.orders
  for each row execute function public.guard_customer_order_insert();

-- ---------- 2. Profile self-edits limited to personal details ----------
-- Before: the only guard kept role, and a store_id once set. A user could
-- link themselves to any shop (then see its unapproved menu and storage
-- folder) and switch their own deactivated account back on.
-- Now, for a person (not the server):
--   role                 never changes (as before)
--   store_id             once set never changes (as before); setting it
--                        the first time is only allowed to a shop that
--                        person manages (shop registration does this)
--   active, status,      only the developer; a manager may switch their
--   rejection_reason     own kitchen staff on/off (active) only
--   email                only the developer (the sign-in system keeps it
--                        in step itself, as the server)
create or replace function public.prevent_role_change()
returns trigger
language plpgsql
as $function$
declare v_actor uuid := auth.uid(); v_actor_role text;
begin
  if new.role is distinct from old.role then
    new.role := old.role;
  end if;
  if old.store_id is not null and new.store_id is distinct from old.store_id then
    new.store_id := old.store_id;
  end if;

  if v_actor is null then return new; end if;               -- the server
  v_actor_role := public.current_role();
  if v_actor_role = 'developer' then return new; end if;

  if old.store_id is null and new.store_id is not null
     and not exists (select 1 from public.stores s where s.id = new.store_id and s.manager_id = new.id) then
    new.store_id := null;
  end if;

  if v_actor = old.id then
    -- your own account: personal details only
    new.active := old.active;
    new.status := old.status;
    new.rejection_reason := old.rejection_reason;
    new.email := old.email;
  else
    -- a manager editing their kitchen staff (the policy limits whose row)
    if v_actor_role is distinct from 'manager' then new.active := old.active; end if;
    new.status := old.status;
    new.rejection_reason := old.rejection_reason;
    new.email := old.email;
  end if;
  return new;
end;
$function$;

-- ---------- 3. Private profile details only to those who need them ----------
-- Before: every signed-in user could read every user's email, phone and
-- student number. Now: yourself; the developer; a shop's manager/kitchen
-- see their own shop's staff and customers who have ordered from it.
drop policy if exists "profiles select all authenticated" on public.profiles;
drop policy if exists "profiles select own" on public.profiles;
create policy "profiles select own" on public.profiles
  for select using (id = auth.uid());
drop policy if exists "profiles select developer" on public.profiles;
create policy "profiles select developer" on public.profiles
  for select using (public.current_role() = 'developer');
drop policy if exists "profiles select shop staff" on public.profiles;
create policy "profiles select shop staff" on public.profiles
  for select using (
    public.current_role() in ('manager', 'kitchen')
    and public.current_store_id() is not null
    and (store_id = public.current_store_id()
         or exists (select 1 from public.orders o where o.customer_id = profiles.id and o.store_id = public.current_store_id()))
  );
create index if not exists orders_store_customer_idx on public.orders (store_id, customer_id);

-- ---------- 4. Who may send a notification to whom ----------
-- Before: anyone signed in could create a notification for anyone (fake
-- "your order is ready"). Now: yourself; the developer anyone; a shop's
-- manager/kitchen only customers who have an order at that shop.
-- (Server functions are not affected.)
drop policy if exists "notif insert authenticated" on public.notifications;
drop policy if exists "notif insert allowed" on public.notifications;
create policy "notif insert allowed" on public.notifications
  for insert with check (
    user_id = auth.uid()
    or public.current_role() = 'developer'
    or (public.current_role() in ('manager', 'kitchen')
        and exists (select 1 from public.orders o where o.customer_id = notifications.user_id and o.store_id = public.current_store_id()))
  );

-- ---------- 5. Server-only functions ----------
-- claim_due_timetable_reminders marks reminders as sent and returns class
-- details: only the reminder job (server key) may call it.
revoke execute on function public.claim_due_timetable_reminders() from public, anon, authenticated;
grant execute on function public.claim_due_timetable_reminders() to service_role;
-- developer_request_status: not for signed-out visitors.
revoke execute on function public.developer_request_status(text) from public, anon;
grant execute on function public.developer_request_status(text) to authenticated, service_role;

-- ---------- 6. Saved cards: only the "default" flag can be changed ----------
revoke update on public.payment_methods from anon, authenticated;
grant update (is_default) on public.payment_methods to authenticated;
