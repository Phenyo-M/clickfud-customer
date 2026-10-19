-- ============================================================
-- ClickFood: shop test mode (2026-10-14)
-- Runs after student_collection_times.sql (replaces ordering_block_reason).
--
-- A shop in test mode stays visible: people can browse its menu, photos
-- and details, but nobody can order from it. Every order path goes through
-- ordering_block_reason (customer orders via enforce_ordering_rules, card
-- payments in create-payfast-payment before payment starts, group orders),
-- so the refusal is in one place. Only the developer (or the server) can
-- switch test mode; a shop manager or student seller cannot.
-- Safe to run more than once. Rollback: shop_test_mode_rollback.sql
-- ============================================================

alter table public.stores add column if not exists test_mode boolean not null default false;

create or replace function public.protect_store_test_mode()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.test_mode is distinct from old.test_mode
     and coalesce(current_setting('request.jwt.claims', true), '') <> ''
     and public."current_role"() is distinct from 'developer' then
    new.test_mode := old.test_mode;
  end if;
  return new;
end $$;
drop trigger if exists trg_protect_store_test_mode on public.stores;
create trigger trg_protect_store_test_mode before update on public.stores
  for each row execute function public.protect_store_test_mode();

create or replace function public.ordering_block_reason(p_store_id uuid, p_item_ids uuid[])
returns text language plpgsql stable security definer set search_path = public as $function$
declare
  v_status jsonb := public.store_status(p_store_id);
  v_name text;
  v_test boolean;
  m record;
begin
  select name, test_mode into v_name, v_test from public.stores where id = p_store_id;
  if coalesce(v_test, false) then
    return coalesce(v_name, 'This shop') || ' is in test mode. You can look around, but ordering isn''t open yet.';
  end if;
  if v_status->>'state' = 'paused' then
    return coalesce(v_name, 'This shop') || ' is temporarily closed'
      || coalesce(' (' || nullif(trim(v_status->>'reason'), '') || ')', '') || ' and isn''t taking new orders.';
  end if;
  -- student shops take orders for a later day/time (checked in student_order_insert)
  if v_status->>'state' = 'closed' and not public.is_student_store(p_store_id) then
    return coalesce(v_name, 'This shop') || ' is closed right now. Please order during its opening hours.';
  end if;
  for m in select id, name, available, availability_windows from public.menu_items
           where id = any (coalesce(p_item_ids, '{}')) and store_id = p_store_id loop
    if not m.available then
      return '"' || m.name || '" is sold out right now.';
    end if;
    if not public.is_student_store(p_store_id) and not public.menu_item_window_ok(m.availability_windows) then
      return '"' || m.name || '" isn''t available at this time of day.';
    end if;
  end loop;
  return null;
end $function$;
