-- Rollback of review_notifications.sql. Product decisions then notify only
-- from an older Developer app build again (redeploy that too). The
-- suspension_reason column stays (harmless).
drop trigger if exists trg_notify_poll_review on public.polls;
drop trigger if exists trg_notify_promo_review on public.promotions;
drop trigger if exists trg_notify_business_shop_decision on public.stores;
drop trigger if exists trg_notify_menu_decision on public.menu_items;
drop trigger if exists trg_notify_student_check_decision on public.student_verifications;
drop function if exists public.notify_poll_review();
drop function if exists public.notify_promo_review();
drop function if exists public.notify_business_shop_decision();
drop function if exists public.notify_menu_decision();
drop function if exists public.notify_student_check_decision();
drop function if exists public.notify_user(uuid, text, text, jsonb);
