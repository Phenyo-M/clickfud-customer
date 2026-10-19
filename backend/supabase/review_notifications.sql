-- =========================================================================
-- ClickFood: every review request and every review decision notifies the
-- right person in their app's notification bell (2026-10-18).
-- Run after poll_review.sql and promo_review.sql. Safe to run more than once.
--
-- All notifications here come from database triggers, so one exists exactly
-- when the change is really saved (a failed approval sends nothing, and a
-- dropped browser connection can't lose one). Messages hold no sensitive
-- details: names of products/shops/codes and the review reason only.
--
-- Already covered before this file (unchanged): to the developer, new
-- business application, publish request, product to review, student shop,
-- Student Entrepreneur application, student email to check, driver
-- application; to students, the entrepreneur decision and the student shop
-- decision (notify_student_shop_review).
--
-- New here:
--   to the developer   poll sent for review, promo code sent for review
--   to the shop        business application approved / not approved / shop removed,
--                      publish request approved / not approved,
--                      product approved / not approved / suspended / back on sale
--                      (moved here from the Developer app's browser),
--                      poll approved / not approved, promo code approved / not approved
--   to the student     student email check approved / not approved / removed
-- =========================================================================

-- a suspended product's reason, so the shop is told why (the Developer app fills it)
alter table public.menu_items add column if not exists suspension_reason text check (suspension_reason is null or char_length(suspension_reason) <= 300);

create or replace function public.notify_user(p_user uuid, p_message text, p_type text, p_link jsonb default null)
returns void language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, message, type, link)
  select p_user, left(p_message, 300), p_type, p_link where p_user is not null;
$$;
revoke all on function public.notify_user(uuid, text, text, jsonb) from public, anon, authenticated;

-- ---------- polls ----------
create or replace function public.notify_poll_review()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_shop text := (select name from public.stores where id = new.store_id);
begin
  if new.status = 'pending_review' and (tg_op = 'INSERT' or old.status is distinct from 'pending_review') then
    perform public.notify_developers('Poll to review from ' || coalesce(v_shop, 'a shop') || ': "' || left(new.question, 80) || '"', 'poll_review',
      jsonb_build_object('kind', 'poll', 'poll_id', new.id, 'store_id', new.store_id));
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status and old.status = 'pending_review' then
    if new.status = 'published' then
      perform public.notify_user(new.created_by, 'Your poll "' || left(new.question, 80) || '" is approved and live for students.', 'poll_approved',
        jsonb_build_object('kind', 'poll', 'poll_id', new.id, 'store_id', new.store_id));
    elsif new.status = 'rejected' then
      perform public.notify_user(new.created_by, 'Your poll "' || left(new.question, 80) || '" was not approved' || coalesce(': ' || nullif(btrim(new.review_note), ''), '.'), 'poll_rejected',
        jsonb_build_object('kind', 'poll', 'poll_id', new.id, 'store_id', new.store_id));
    end if;
  end if;
  return null;
end $$;
drop trigger if exists trg_notify_poll_review on public.polls;
create trigger trg_notify_poll_review after insert or update on public.polls for each row execute function public.notify_poll_review();

-- ---------- promo codes ----------
create or replace function public.notify_promo_review()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_store public.stores;
begin
  select * into v_store from public.stores where id = new.store_id;
  if new.review_status = 'pending_review' and (tg_op = 'INSERT' or old.review_status is distinct from 'pending_review') then
    perform public.notify_developers('Promo code to review from ' || coalesce(v_store.name, 'a shop') || ': ' || new.code || '.', 'promo_review',
      jsonb_build_object('kind', 'promo', 'promotion_id', new.id, 'store_id', new.store_id));
  elsif tg_op = 'UPDATE' and new.review_status is distinct from old.review_status and old.review_status = 'pending_review' then
    if new.review_status = 'approved' then
      perform public.notify_user(v_store.manager_id, 'Your promo code ' || new.code || ' is approved. Customers can use it now.', 'promo_approved',
        jsonb_build_object('kind', 'promo', 'promotion_id', new.id, 'store_id', new.store_id));
    elsif new.review_status = 'rejected' then
      perform public.notify_user(v_store.manager_id, 'Your promo code ' || new.code || ' was not approved' || coalesce(': ' || nullif(btrim(new.review_note), ''), '.'), 'promo_rejected',
        jsonb_build_object('kind', 'promo', 'promotion_id', new.id, 'store_id', new.store_id));
    end if;
  end if;
  return null;
end $$;
drop trigger if exists trg_notify_promo_review on public.promotions;
create trigger trg_notify_promo_review after insert or update on public.promotions for each row execute function public.notify_promo_review();

-- ---------- business shops (student shops already notify in notify_student_shop_review) ----------
create or replace function public.notify_business_shop_decision()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_link jsonb := jsonb_build_object('kind', 'store', 'store_id', new.id);
begin
  if new.seller_kind is distinct from 'business' then return null; end if;
  if new.status is distinct from old.status then
    if new.status = 'approved' and old.status in ('pending', 'rejected') then
      perform public.notify_user(new.manager_id, 'Your business application for ' || new.name || ' is approved. Add your products, then send a publish request.', 'store_approved', v_link);
    elsif new.status = 'rejected' then
      perform public.notify_user(new.manager_id, 'Your business application for ' || new.name || ' was not approved' || coalesce(': ' || nullif(btrim(new.rejection_reason), ''), '.'), 'store_rejected', v_link);
    elsif new.status = 'archived' and new.archived_by is distinct from new.manager_id then
      perform public.notify_user(new.manager_id, 'Your shop ' || new.name || ' was removed from ClickFood.', 'store_removed', v_link);
    end if;
  end if;
  if new.is_published and not coalesce(old.is_published, false) and new.publish_requested_at is not null then
    perform public.notify_user(new.manager_id, 'Your publish request is approved. ' || new.name || ' is now live for customers.', 'publish_approved', v_link);
  elsif nullif(btrim(new.publish_rejection_reason), '') is not null and new.publish_rejection_reason is distinct from old.publish_rejection_reason then
    perform public.notify_user(new.manager_id, 'Your publish request for ' || new.name || ' was not approved: ' || btrim(new.publish_rejection_reason), 'publish_rejected', v_link);
  end if;
  return null;
end $$;
drop trigger if exists trg_notify_business_shop_decision on public.stores;
create trigger trg_notify_business_shop_decision after update on public.stores for each row execute function public.notify_business_shop_decision();

-- ---------- products (the shop of a business or a student) ----------
create or replace function public.notify_menu_decision()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_store public.stores;
  v_link jsonb := jsonb_build_object('kind', 'menu_item', 'menu_item_id', new.id, 'store_id', new.store_id);
  v_fee text := '';
begin
  if new.status is not distinct from old.status then return null; end if;
  select * into v_store from public.stores where id = new.store_id;
  if v_store.manager_id is null then return null; end if;
  if new.status = 'approved' and old.status = 'suspended' then
    perform public.notify_user(v_store.manager_id, 'Your "' || new.name || '" is back on sale.', 'menu_approved', v_link);
  elsif new.status = 'approved' then
    if coalesce(new.platform_fee_amount, 0) > 0 then
      v_fee := ' A platform fee of R' || to_char(new.platform_fee_amount, 'FM999990.00') || ' has been added to its price (shop price stays R' || to_char(new.price, 'FM999990.00') || ').';
    end if;
    perform public.notify_user(v_store.manager_id, 'Your "' || new.name || '" is approved and now visible to customers.' || v_fee, 'menu_approved', v_link);
  elsif new.status = 'rejected' then
    perform public.notify_user(v_store.manager_id, 'Your "' || new.name || '" was not approved' || coalesce(': ' || nullif(btrim(new.rejection_reason), ''), '.'), 'menu_rejected', v_link);
  elsif new.status = 'suspended' then
    perform public.notify_user(v_store.manager_id, 'Your "' || new.name || '" was suspended' || coalesce(': ' || nullif(btrim(new.suspension_reason), ''), '.'), 'menu_suspended', v_link);
  end if;
  return null;
end $$;
drop trigger if exists trg_notify_menu_decision on public.menu_items;
create trigger trg_notify_menu_decision after update on public.menu_items for each row execute function public.notify_menu_decision();

-- ---------- student email checks the developer decided ----------
create or replace function public.notify_student_check_decision()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_link jsonb := jsonb_build_object('kind', 'student_verification');
begin
  if new.status is not distinct from old.status or new.reviewed_by is null then return null; end if;   -- only a developer's review
  if new.status = 'verified' then
    perform public.notify_user(new.user_id, 'Your student email ' || new.email || ' is approved. You now get student deals.', 'student_verified', v_link);
  elsif new.status = 'rejected' then
    perform public.notify_user(new.user_id, 'Your student email ' || new.email || ' was not approved' || coalesce(': ' || nullif(btrim(new.review_note), ''), '.'), 'student_rejected', v_link);
  elsif new.status = 'revoked' then
    perform public.notify_user(new.user_id, 'Your student status was removed' || coalesce(': ' || nullif(btrim(new.review_note), ''), '.'), 'student_revoked', v_link);
  end if;
  return null;
end $$;
drop trigger if exists trg_notify_student_check_decision on public.student_verifications;
create trigger trg_notify_student_check_decision after update on public.student_verifications for each row execute function public.notify_student_check_decision();
