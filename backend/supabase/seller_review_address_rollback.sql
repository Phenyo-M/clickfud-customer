-- Undo supabase/seller_review_address.sql (back to student_sellers.sql
-- behaviour). Addresses, pins and hustleUP answers are kept as data.
begin;
drop trigger if exists trg_validate_student_shop on public.stores;
drop trigger if exists trg_recheck_student_shop_published on public.menu_items;
drop trigger if exists trg_notify_student_shop_review on public.stores;
drop function if exists public.validate_student_shop();
drop function if exists public.recheck_student_shop_published();
drop function if exists public.notify_student_shop_review();
drop function if exists public.publish_student_shop();
drop function if exists public.set_hustleup_member(boolean);
drop function if exists public.become_student_seller(text, text, text[], text, text, text, text, text, text, double precision, double precision, boolean, boolean);
commit;
-- Then re-run supabase/student_sellers.sql to restore the previous
-- become_student_seller() and student_order_insert().
