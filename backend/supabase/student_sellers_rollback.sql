-- Undo supabase/student_sellers.sql. Student shops, their products and
-- orders are archived/kept (not deleted); only the new rules go away.
begin;
update public.stores set status = 'archived', is_published = false, archived_reason = 'student sellers rolled back'
 where seller_kind = 'student';

drop trigger if exists trg_protect_store_seller_kind on public.stores;
drop trigger if exists trg_enforce_student_menu_item on public.menu_items;
drop trigger if exists trg_ab_student_order_insert on public.orders;
drop trigger if exists trg_notify_student_seller on public.orders;
drop policy if exists "menu student seller insert" on public.menu_items;
drop policy if exists "menu student seller update" on public.menu_items;
drop policy if exists "menu student seller delete" on public.menu_items;
drop policy if exists "orders select student seller" on public.orders;

drop function if exists public.become_student_seller(text, text, text[], text, text, text, text, boolean);
drop function if exists public.update_seller_profile(text, text[], text);
drop function if exists public.seller_contact(uuid);
drop function if exists public.seller_update_order(uuid, text, text, text);
drop function if exists public.protect_store_seller_kind();
drop function if exists public.enforce_student_menu_item();
drop function if exists public.student_order_insert();
drop function if exists public.notify_student_seller();

-- the two collection triggers, as they were
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

create or replace function public.track_collection_window()
returns trigger language plpgsql security definer set search_path = public as $function$
declare
  v_deadline timestamptz;
begin
  if coalesce(new.delivery_location->>'fulfilment', '') <> 'collection' then
    return new;
  end if;
  if new.status = 'ready' and old.status is distinct from 'ready' then
    v_deadline := greatest(now(), coalesce(new.rescheduled_for, now()))
                  + make_interval(mins => public.collection_setting('window'));
    new.ready_at := now();
    new.original_ready_at := coalesce(old.original_ready_at, now());
    new.collection_deadline := v_deadline;
    new.original_collection_deadline := coalesce(old.original_collection_deadline, v_deadline);
    new.collection_state := case when coalesce(new.reschedule_count, 0) > 0 then 'rescheduled' else 'window' end;
    new.collection_response_deadline := null;
    new.needs_reprep := false;
    new.released_at := null; -- freshly made: this food is here
  end if;
  if new.status = 'collected' and old.status is distinct from 'collected' then
    new.collection_state := 'collected';
    new.collection_response_deadline := null;
  end if;
  return new;
end;
$function$;

drop function if exists public.current_seller_store_id();
drop function if exists public.is_student_store(uuid);
-- Kept on purpose (harmless, hold data): stores.seller_kind,
-- menu_items.other_food_detail, the wider category list, seller_profiles,
-- and the helper word/number functions.
commit;
