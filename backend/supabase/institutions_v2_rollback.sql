-- Rollback for institutions_v2.sql (campus rows and institution settings columns are kept)
drop trigger if exists trg_a0_protect_student_profile on public.profiles;
drop function if exists public.protect_student_profile();
drop trigger if exists trg_b4_order_shop_visible on public.orders;
drop function if exists public.enforce_order_shop_visible();
drop trigger if exists trg_group_shop_visible on public.group_orders;
drop function if exists public.enforce_group_shop_visible();
drop trigger if exists trg_entrepreneur_student_only on public.entrepreneur_applications;
drop function if exists public.entrepreneur_student_only();
drop function if exists public.set_my_shop_audience(text);
drop function if exists public.dev_unclassified_shops();
drop function if exists public.dev_save_institution(uuid, jsonb);
drop function if exists public.dev_save_campus(uuid, jsonb);
-- shops and menus visible to everyone again (the earlier rules)
drop policy if exists "stores select visible" on public.stores;
drop policy if exists "stores select all" on public.stores;
create policy "stores select all" on public.stores for select using (((status = 'approved') and (is_published = true)) or (manager_id = auth.uid()) or (public."current_role"() = 'developer'));
drop policy if exists "menu select" on public.menu_items;
create policy "menu select" on public.menu_items for select using ((status = 'approved') or (store_id = public.current_store_id()) or (public."current_role"() = 'developer'));
drop policy if exists "campus venues read" on public.campus_venues;
create policy "campus venues read" on public.campus_venues for select to anon, authenticated using ((active and verification = 'verified_current') or (public."current_role"() = 'developer'));
grant select on public.campus_venues to anon;
-- then re-run: order_distance.sql (set_my_student_status), student_entrepreneurs.sql (entrepreneur functions), student_sellers.sql section for seller_contact if needed
