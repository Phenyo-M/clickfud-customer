-- ============================================================
-- CLICKFOOD, student shops for everyone + developer report on student
-- sellers (2026-10-17). Needs institutions_v2.sql first.
--
-- 1. Owner's rule: every account (students of any institution,
--    non-students and visitors) sees STUDENT shops and general shops.
--    Business shops on a campus stay visible only to students of that
--    institution (and to past customers).
-- 2. dev_student_sellers(): student accounts that own a shop, with their
--    student details and their shop's orders. Developer role only.
-- Safe to run more than once. Rollback: student_shops_open_rollback.sql
-- ============================================================

create or replace function public.store_audience_ok(p_store uuid, p_location_type text, p_availability text, p_seller_kind text)
returns boolean language sql stable security definer set search_path = public as $$
  select p_seller_kind = 'student'                                   -- student shops: everyone
      or p_location_type = 'off_campus' or p_availability = 'everyone'   -- general shops: everyone
      or exists (select 1 from public.profiles p join public.store_universities su on su.university_id = p.home_university_id
                  where p.id = auth.uid() and p.role = 'customer' and coalesce(p.is_student, false) and su.store_id = p_store)
      or (auth.uid() is not null and exists (select 1 from public.orders o where o.store_id = p_store and o.customer_id = auth.uid()))
$$;
grant execute on function public.store_audience_ok(uuid, text, text, text) to anon, authenticated;

drop policy if exists "stores select visible" on public.stores;
create policy "stores select visible" on public.stores for select using (
  public."current_role"() = 'developer'
  or manager_id = auth.uid()
  or id = public.current_store_id()
  or (status = 'approved' and is_published = true and public.store_audience_ok(id, location_type, availability, seller_kind))
);

create or replace function public.store_visible_to_me(p_store uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.stores s where s.id = p_store and s.status = 'approved' and s.is_published
                   and public.store_audience_ok(s.id, s.location_type, s.availability, s.seller_kind))
$$;

create or replace function public.seller_contact(p_store_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select sp.whatsapp from public.seller_profiles sp
    join public.stores s on s.id = sp.store_id
   where sp.store_id = p_store_id and auth.uid() is not null
     and s.seller_kind = 'student'
     -- as in seller_whatsapp.sql: a live student shop, or one the customer already ordered from
     and ((s.status = 'approved' and s.is_published)
          or (s.status <> 'archived' and exists (select 1 from public.orders o where o.store_id = p_store_id and o.customer_id = auth.uid())))
$$;
revoke all on function public.seller_contact(uuid) from public, anon;
grant execute on function public.seller_contact(uuid) to authenticated;

drop function if exists public.store_audience_ok(uuid, text, text);

-- discovery: student shops of another institution sit with "available to everyone"
create or replace function public.discover_shops(p_university uuid default null)
returns table (store_id uuid, section text, rank int, university_ids uuid[], universities text[], campus_ids uuid[])
language sql stable security invoker set search_path = public as $$
  with me as (
    select coalesce(p_university, (select home_university_id from public.profiles where id = auth.uid())) as uni
  ),
  flags as (select coalesce((public.public_app_flags()->>'show_partner_shops')::boolean, false) as partners),
  s as (
    select st.id, st.availability, st.location_type, st.rating, st.rating_count, st.seller_kind,
           coalesce(array_agg(distinct su.university_id) filter (where su.university_id is not null), '{}') as uids,
           coalesce(array_agg(distinct u.name) filter (where u.name is not null), '{}') as unames,
           coalesce((select array_agg(sc.campus_id) from public.store_campuses sc where sc.store_id = st.id), '{}') as cids
      from public.stores st
      left join public.store_universities su on su.store_id = st.id
      left join public.universities u on u.id = su.university_id
     where st.status = 'approved' and st.is_published = true
     group by st.id
  )
  select s.id,
         case when (select uni from me) is not null and (select uni from me) = any (s.uids) and s.location_type = 'campus' then 'mine'
              when s.availability = 'everyone' or s.location_type = 'off_campus' or s.seller_kind = 'student' then 'everyone' else 'other' end,
         row_number() over (order by
           case when (select uni from me) is not null and (select uni from me) = any (s.uids) and s.location_type = 'campus' then 0
                when s.availability = 'everyone' or s.location_type = 'off_campus' or s.seller_kind = 'student' then 1 else 2 end,
           coalesce(s.rating_count, 0) desc, coalesce(s.rating, 0) desc, s.id)::int,
         s.uids, s.unames, s.cids
    from s, flags
   where flags.partners or s.seller_kind = 'student'
$$;
revoke all on function public.discover_shops(uuid) from public;
grant execute on function public.discover_shops(uuid) to anon, authenticated;

-- ---------- developer report: student accounts with a shop ----------
create or replace function public.dev_student_sellers()
returns table (
  owner_id uuid, owner_name text, login_email text, phone text, whatsapp text,
  is_student boolean, institution text, campus text, student_email_verified boolean, verified_email text,
  application_status text, application_submitted_at timestamptz,
  store_id uuid, shop_name text, shop_status text, is_published boolean, test_mode boolean, shop_created_at timestamptz,
  orders_total int, orders_completed int, orders_active int, orders_cancelled int, sales numeric, last_order_at timestamptz,
  rating numeric, rating_count int, joined_at timestamptz
) language sql stable security definer set search_path = public as $$
  select p.id, p.name, au.email, p.phone, sp.whatsapp,
         coalesce(p.is_student, false), u.name, p.campus_location,
         -- a confirmed student login email, or a student email proved by the link
         ((au.email_confirmed_at is not null and exists (select 1 from public.allowed_domains d where d.domain = public.email_domain_of(au.email) and d.active))
           or exists (select 1 from public.student_verifications v where v.user_id = p.id and v.status = 'verified')),
         coalesce((select v.email from public.student_verifications v where v.user_id = p.id and v.status = 'verified' order by v.verified_at desc limit 1),
                  case when exists (select 1 from public.allowed_domains d where d.domain = public.email_domain_of(au.email)) then au.email end),
         a.status, a.submitted_at,
         s.id, s.name, s.status, s.is_published, coalesce(s.test_mode, false), s.created_at,
         coalesce(o.total, 0), coalesce(o.completed, 0), coalesce(o.active, 0), coalesce(o.cancelled, 0), coalesce(o.sales, 0), o.last_at,
         s.rating, coalesce(s.rating_count, 0), au.created_at
    from public.stores s
    join public.profiles p on p.id = s.manager_id
    left join auth.users au on au.id = p.id
    left join public.universities u on u.id = p.home_university_id
    left join public.seller_profiles sp on sp.store_id = s.id
    left join lateral (select ea.status, ea.submitted_at from public.entrepreneur_applications ea where ea.user_id = p.id order by ea.updated_at desc limit 1) a on true
    left join lateral (
      select count(*)::int total,
             count(*) filter (where ord.status in ('collected', 'delivered'))::int completed,
             count(*) filter (where ord.status in ('received', 'preparing', 'ready', 'out_for_delivery'))::int active,
             count(*) filter (where ord.status in ('cancelled', 'uncollected'))::int cancelled,
             coalesce(sum(ord.total) filter (where ord.status in ('collected', 'delivered')), 0) sales,
             max(ord.created_at) last_at
        from public.orders ord where ord.store_id = s.id) o on true
   where public."current_role"() = 'developer' and s.seller_kind = 'student' and p.role = 'customer'
   order by coalesce(o.last_at, s.created_at) desc
$$;
revoke all on function public.dev_student_sellers() from public, anon;
grant execute on function public.dev_student_sellers() to authenticated;
