-- =========================================================================
-- CLICKFOOD — undo supabase/security_phase1.sql
-- Restores the exact definitions that were live on 2026-10-04 before it.
-- (This re-opens the security holes it fixed: use only to back out a
-- problem, then fix forward.)
-- =========================================================================
drop trigger if exists trg_aa_guard_customer_order_insert on public.orders;
drop function if exists public.guard_customer_order_insert();

create or replace function public.prevent_role_change()
returns trigger
language plpgsql
as $function$
begin
  if new.role is distinct from old.role then
    new.role := old.role;
  end if;
  if old.store_id is not null and new.store_id is distinct from old.store_id then
    new.store_id := old.store_id;
  end if;
  return new;
end;
$function$;

drop policy if exists "profiles select own" on public.profiles;
drop policy if exists "profiles select developer" on public.profiles;
drop policy if exists "profiles select shop staff" on public.profiles;
drop policy if exists "profiles select all authenticated" on public.profiles;
create policy "profiles select all authenticated" on public.profiles for select using (auth.uid() is not null);

drop policy if exists "notif insert allowed" on public.notifications;
drop policy if exists "notif insert authenticated" on public.notifications;
create policy "notif insert authenticated" on public.notifications for insert with check (auth.uid() is not null);

grant execute on function public.claim_due_timetable_reminders() to public, anon, authenticated;
grant execute on function public.developer_request_status(text) to public, anon;

grant update on public.payment_methods to authenticated;
-- orders_store_customer_idx is kept (an index only speeds things up).
