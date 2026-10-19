-- Rollback for student_shops_open.sql: back to the institutions_v2.sql rules
drop function if exists public.dev_student_sellers();
create or replace function public.store_audience_ok(p_store uuid, p_location_type text, p_availability text)
returns boolean language sql stable security definer set search_path = public as $$
  select p_location_type = 'off_campus' or p_availability = 'everyone'
      or exists (select 1 from public.profiles p join public.store_universities su on su.university_id = p.home_university_id
                  where p.id = auth.uid() and p.role = 'customer' and coalesce(p.is_student, false) and su.store_id = p_store)
      or (auth.uid() is not null and exists (select 1 from public.orders o where o.store_id = p_store and o.customer_id = auth.uid()))
$$;
grant execute on function public.store_audience_ok(uuid, text, text) to anon, authenticated;
drop policy if exists "stores select visible" on public.stores;
create policy "stores select visible" on public.stores for select using (
  public."current_role"() = 'developer' or manager_id = auth.uid() or id = public.current_store_id()
  or (status = 'approved' and is_published = true and public.store_audience_ok(id, location_type, availability)));
create or replace function public.store_visible_to_me(p_store uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.stores s where s.id = p_store and s.status = 'approved' and s.is_published
                   and public.store_audience_ok(s.id, s.location_type, s.availability))
$$;
drop function if exists public.store_audience_ok(uuid, text, text, text);
-- seller_contact: re-run institutions_v2.sql section 4 to restore its audience check
