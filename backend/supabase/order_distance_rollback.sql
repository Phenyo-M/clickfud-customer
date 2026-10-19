-- Rollback for order_distance.sql (campus pins and settings columns are kept)
drop trigger if exists trg_b5_enforce_order_distance on public.orders;
drop trigger if exists trg_enforce_group_distance on public.group_orders;
drop trigger if exists trg_check_saved_location on public.profiles;
drop function if exists public.enforce_order_distance();
drop function if exists public.enforce_group_distance();
drop function if exists public.check_saved_location();
drop function if exists public.check_my_order_distance(uuid, jsonb);
drop function if exists public.order_distance_check(uuid, uuid, jsonb);
drop function if exists public.nearest_campus(uuid, double precision, double precision, numeric);
drop function if exists public.dev_set_campus_location(uuid, double precision, double precision, text);
drop function if exists public.dev_set_order_distance(numeric, boolean);
-- set_my_student_status / public_app_flags: re-run open_signup_students.sql and payment_options.sql to restore the earlier versions
