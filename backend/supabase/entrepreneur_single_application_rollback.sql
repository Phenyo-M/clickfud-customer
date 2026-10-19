-- Rollback for entrepreneur_single_application.sql
drop index if exists public.entrepreneur_applications_one_per_user;
drop function if exists public.save_shop_setup_draft(jsonb);
drop table if exists public.shop_setup_drafts;
-- then re-run student_entrepreneurs.sql (save_entrepreneur_application, link_entrepreneur_shop) and institutions_v2.sql + student_shops_open.sql after it
