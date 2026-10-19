-- ============================================================
-- ClickFood: clickable notifications (2026-10-12)
--
-- notifications.link (jsonb) says what a notification is about, so each
-- app can open the right page when it's tapped:
--   { "kind": "order", "order_id", "store_id" }   an order (from "ORD-..." in the text)
--   { "kind": "menu_item", "menu_item_id", "store_id" }
--   { "kind": "store", "store_id" }
--   { "kind": "<type>" }                          everything else (the app maps the type)
-- A trigger fills it in for every new notification that doesn't set one,
-- so none of the many existing senders had to change; old rows are
-- back-filled once.
--
-- Also new: the developer is now notified (with a link) when something is
-- waiting for review: a product, a business application, a publish
-- request, or a driver application.
-- Safe to run more than once.
-- ============================================================

alter table public.notifications add column if not exists link jsonb;

create or replace function public.notification_link_for(p_type text, p_message text, p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_num text := substring(coalesce(p_message, '') from 'ORD-[0-9]{4}-[0-9]+');
  v_quoted text := substring(coalesce(p_message, '') from '"([^"]+)"');
  v_order record;
  v_item uuid;
  v_store uuid;
  v_name text;
begin
  if v_num is not null then
    select id, store_id into v_order from public.orders where order_number = v_num;
    if found then return jsonb_build_object('kind', 'order', 'order_id', v_order.id, 'store_id', v_order.store_id); end if;
  end if;
  if p_type like 'menu_%' and v_quoted is not null then
    select m.id, m.store_id into v_item, v_store from public.menu_items m
      join public.stores s on s.id = m.store_id
     where m.name = v_quoted and s.manager_id = p_user
     order by m.created_at desc limit 1;
    if v_item is not null then return jsonb_build_object('kind', 'menu_item', 'menu_item_id', v_item, 'store_id', v_store); end if;
  end if;
  if p_type in ('store_review', 'publish_request') then
    -- "New student shop to review: NAME (hustleUP member)." / "Publish request: NAME."
    v_name := btrim(regexp_replace(regexp_replace(split_part(coalesce(p_message, ''), ': ', 2), ' \(hustleUP member\)', ''), '\.$', ''));
    select id into v_store from public.stores where name = v_name order by created_at desc limit 1;
    if v_store is not null then return jsonb_build_object('kind', 'store', 'store_id', v_store); end if;
  end if;
  return jsonb_build_object('kind', coalesce(p_type, 'info'));
end $$;

create or replace function public.fill_notification_link()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.link is null then new.link := public.notification_link_for(new.type, new.message, new.user_id); end if;
  return new;
end $$;
drop trigger if exists trg_fill_notification_link on public.notifications;
create trigger trg_fill_notification_link before insert on public.notifications
  for each row execute function public.fill_notification_link();

update public.notifications set link = public.notification_link_for(type, message, user_id) where link is null;

-- ---------- tell the developer what is waiting for review ----------
create or replace function public.notify_developers(p_message text, p_type text, p_link jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, message, type, link)
  select id, p_message, p_type, p_link from public.profiles where role = 'developer' and coalesce(active, true)
$$;
revoke all on function public.notify_developers(text, text, jsonb) from public, anon, authenticated;

create or replace function public.notify_menu_review()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'pending' and (tg_op = 'INSERT' or old.status is distinct from 'pending') then
    perform public.notify_developers(
      'New product to review: ' || new.name || ' (' || coalesce((select name from public.stores where id = new.store_id), 'a shop') || ').',
      'menu_review', jsonb_build_object('kind', 'menu_item', 'menu_item_id', new.id, 'store_id', new.store_id));
  end if;
  return null;
end $$;
drop trigger if exists trg_notify_menu_review on public.menu_items;
create trigger trg_notify_menu_review after insert or update of status on public.menu_items
  for each row execute function public.notify_menu_review();

create or replace function public.notify_store_review()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- student shops already notify from become_student_seller()
  if new.seller_kind = 'business' and new.status = 'pending'
     and (tg_op = 'INSERT' or old.status is distinct from 'pending') then
    perform public.notify_developers('New business application: ' || new.name || '.', 'store_review',
      jsonb_build_object('kind', 'store', 'store_id', new.id));
  end if;
  if tg_op = 'UPDATE' and new.seller_kind = 'business' and new.publish_requested_at is not null
     and new.publish_requested_at is distinct from old.publish_requested_at and not new.is_published then
    perform public.notify_developers('Publish request: ' || new.name || '.', 'publish_request',
      jsonb_build_object('kind', 'store', 'store_id', new.id));
  end if;
  return null;
end $$;
drop trigger if exists trg_notify_store_review on public.stores;
create trigger trg_notify_store_review after insert or update of status, publish_requested_at on public.stores
  for each row execute function public.notify_store_review();

create or replace function public.notify_driver_review()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role = 'driver' and new.status = 'pending'
     and (tg_op = 'INSERT' or old.status is distinct from 'pending') then
    perform public.notify_developers('New driver application: ' || coalesce(new.name, 'a driver') || '.', 'driver_review',
      jsonb_build_object('kind', 'driver', 'profile_id', new.id));
  end if;
  return null;
end $$;
drop trigger if exists trg_notify_driver_review on public.profiles;
create trigger trg_notify_driver_review after insert or update of status on public.profiles
  for each row execute function public.notify_driver_review();
