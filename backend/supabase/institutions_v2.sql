-- ============================================================
-- CLICKFOOD, multi-institution upgrade (2026-10-17)
-- Needs multi_university.sql, tut_campuses.sql, open_signup_students.sql,
-- student_entrepreneurs.sql and order_distance.sql first.
--
-- 1. Institution settings (universities): registration_open, features
--    (orientation, entrepreneurs). Managed by developers only, through
--    dev_save_institution / dev_save_campus (new institutions start closed).
-- 2. Campuses for Rosebank College, Eduvos and UNISA, from each
--    institution's own website (source + date on every row). No
--    coordinates, no buildings are invented.
-- 3. The profile's account type and institution (is_student,
--    home_university_id, university, campus) change only through checked
--    functions; a verified student stays with the verified institution.
-- 4. Shop visibility, enforced by RLS on stores (and so on menus,
--    discovery and search):
--      general shop        = off campus, or "everyone" audience: everyone
--      institution shop    = on campus with "university" audience: only
--                            students of the shop's institution(s)
--      unclassified campus shop (no institution linked): nobody but staff
--    A customer always keeps seeing shops they ordered from (history).
--    Orders, group orders and seller contact check the same rule.
-- 5. Student Entrepreneurs: every institution with the feature on (all five);
--    student accounts only.
-- 6. Campus buildings (venues): readable by students of that institution.
-- Existing users, shops and orders are kept. Safe to run more than once.
-- Rollback: institutions_v2_rollback.sql
-- ============================================================

-- ---------- 1. institution settings ----------
alter table public.universities add column if not exists registration_open boolean not null default true;
alter table public.universities add column if not exists features jsonb not null default '{"orientation": true, "entrepreneurs": true}'::jsonb;
update public.universities set features = coalesce(features, '{}'::jsonb) || '{"orientation": true, "entrepreneurs": true}'::jsonb
 where name in ('University of Pretoria', 'Tshwane University of Technology', 'Rosebank College', 'Eduvos', 'University of South Africa')
   and not (features ? 'orientation' and features ? 'entrepreneurs');
revoke insert, update, delete on public.universities, public.campuses from anon, authenticated;

create or replace function public.institution_feature(p_university uuid, p_feature text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select active and coalesce((features->>p_feature)::boolean, false) from public.universities where id = p_university), false)
$$;
grant execute on function public.institution_feature(uuid, text) to anon, authenticated;

-- ---------- 2. campuses from official pages ----------
do $$
declare rc uuid; edu uuid; un uuid;
  rc_src text := 'https://rosebankcollege.co.za/admissions/information-for-parents';
  edu_src text := 'https://www.eduvos.com/campuscontacts';
  un_src text := 'https://unisa.ac.za/sites/corporate/default/Contact-us/Campus-maps-&-addresses';
begin
  select id into rc from public.universities where name = 'Rosebank College';
  select id into edu from public.universities where name = 'Eduvos';
  select id into un from public.universities where name = 'University of South Africa';
  if rc is not null then
    insert into public.campuses (university_id, code, name, full_name, address, address_verified, source_url, notes, verification, last_verified, sort)
    select rc, 'rc-' || trim(both '-' from lower(regexp_replace(n, '[^A-Za-z]+', '-', 'g'))), n, n || ' Campus', null, false, rc_src,
           'Campus listed on the official Rosebank College site. No street address on that page.', 'verified_current', date '2026-10-17', s
      from (values ('Bloemfontein', 10), ('Braamfontein', 20), ('Cape Town', 30), ('Durban', 40), ('Nelson Mandela Bay', 50),
                   ('Mbombela', 60), ('Polokwane', 70), ('Pretoria', 80)) v(n, s)
    on conflict (code) do nothing;
  end if;
  if edu is not null then
    insert into public.campuses (university_id, code, name, full_name, address, address_verified, source_url, notes, verification, last_verified, sort)
    select edu, 'edu-' || trim(both '-' from lower(regexp_replace(n, '[^A-Za-z]+', '-', 'g'))), n, n || ' Campus', a, true, edu_src,
           'Name and address from the official Eduvos campus contacts page.', 'verified_current', date '2026-10-17', s
      from (values
        ('Bedfordview', 'Gillooly''s View Office Park, 1 Osborne Lane, Bedfordview, Johannesburg, 2008', 10),
        ('Bloemfontein', '161 Zastron St, Westdene, Bloemfontein, 9301', 20),
        ('Durban (Umhlanga)', '1D Lunar Row, Umhlanga Ridge Boulevard, Umhlanga New Town Centre, 4319', 30),
        ('East London', '12 Stewart Drive, Berea, East London, 5241', 40),
        ('Mbombela', 'The Grove shopping centre, Corner R40 White River Road & Gorge Street, Riverside, 1200', 50),
        ('Midrand', '44 Alsatian Road, Glen Austin, Midrand, 1685', 60),
        ('Mowbray', 'River Park, River Lane, Mowbray, Cape Town, 7708', 70),
        ('Nelson Mandela Bay', '96 Second Avenue, Newton Park, Port Elizabeth, 6045', 80),
        ('Potchefstroom', '12 Esselen Street, Die Bult, Potchefstroom, 2531', 90),
        ('Pretoria', '22 Umgazi Street, Ashlea Gardens, Pretoria, 0081', 100),
        ('Tyger Valley', 'Kaapzicht Building, 9 Rogers St, Tyger Valley, Cape Town, 7530', 110),
        ('Vaal', '101 Hendrik van Eck Boulevard, S.E.6, Vanderbijlpark, 1911', 120)) v(n, a, s)
    on conflict (code) do nothing;
  end if;
  if un is not null then
    insert into public.campuses (university_id, code, name, full_name, address, address_verified, source_url, notes, verification, last_verified, sort)
    select un, c, n, f, a, true, un_src, 'Name and address from the official UNISA campus maps & addresses page.', 'verified_current', date '2026-10-17', s
      from (values
        ('unisa-muckleneuk', 'Muckleneuk', 'Muckleneuk Campus', 'Preller Street, Muckleneuk, Pretoria', 10),
        ('unisa-science', 'Science Campus', 'Science Campus (Florida)', 'Corner of Christiaan de Wet Road & Pioneer Avenue, Florida, 1709', 20),
        ('unisa-sunnyside', 'Sunnyside', 'Sunnyside Campus', 'Corner of Justice Mohammed and Steve Biko streets, Sunnyside', 30)) v(c, n, f, a, s)
    on conflict (code) do nothing;
  end if;
end $$;

-- ---------- 3. account type + institution only through checked functions ----------
create or replace function public.protect_student_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('request.jwt.claims', true), '') = ''            -- the server / migrations
     or coalesce(current_setting('clickfood.profile_change', true), '') = 'on'  -- set_my_student_status
     or public."current_role"() = 'developer' or new.role = 'deleted' then
    return new;
  end if;
  if new.is_student is distinct from old.is_student or new.home_university_id is distinct from old.home_university_id
     or new.university is distinct from old.university or new.campus_location is distinct from old.campus_location then
    raise exception 'Change your student status, institution or campus in Profile.' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.protect_student_profile() from public, anon, authenticated;
drop trigger if exists trg_a0_protect_student_profile on public.profiles;
create trigger trg_a0_protect_student_profile before update on public.profiles
  for each row execute function public.protect_student_profile();

-- set_my_student_status (order_distance.sql version) + institution rules
create or replace function public.set_my_student_status(p_is_student boolean, p_university uuid default null, p_campus uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_uni public.universities; v_campus public.campuses; v_prof public.profiles; v_problem text; v_verified uuid;
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid and role = 'customer') then
    return jsonb_build_object('ok', false, 'error', 'Please sign in.');
  end if;
  if p_is_student is null then return jsonb_build_object('ok', false, 'error', 'Please choose an answer.'); end if;
  perform set_config('clickfood.profile_change', 'on', true);
  select * into v_prof from public.profiles where id = v_uid;
  -- a verified student email ties the account to that institution
  select university_id into v_verified from public.student_verifications
   where user_id = v_uid and status = 'verified' and (expires_at is null or expires_at > now()) and university_id is not null
   order by verified_at desc limit 1;
  if not p_is_student then
    if v_verified is not null then return jsonb_build_object('ok', false, 'error', 'Your student email is verified, so your account stays a student account.'); end if;
    update public.profiles set is_student = false, university = null, campus_location = null, home_university_id = null, preferred_venue_id = null where id = v_uid;
    return jsonb_build_object('ok', true, 'is_student', false);
  end if;
  select * into v_uni from public.universities where id = p_university and active;
  if not found then return jsonb_build_object('ok', false, 'error', 'Please choose your institution.'); end if;
  if v_verified is not null and v_verified <> v_uni.id then
    return jsonb_build_object('ok', false, 'error', 'Your verified student email belongs to ' || coalesce((select name from public.universities where id = v_verified), 'another institution') || '.');
  end if;
  if v_uni.id is distinct from v_prof.home_university_id and not v_uni.registration_open then
    return jsonb_build_object('ok', false, 'error', 'Students from ' || v_uni.name || ' can''t join ClickFood yet.');
  end if;
  if p_campus is not null then
    select * into v_campus from public.campuses where id = p_campus and university_id = v_uni.id and active;
    if not found then return jsonb_build_object('ok', false, 'error', 'Please choose a campus of your institution.'); end if;
  elsif exists (select 1 from public.campuses where university_id = v_uni.id and active) then
    return jsonb_build_object('ok', false, 'error', 'Please choose your campus.');
  end if;
  v_problem := public.saved_location_problem(v_campus.id, v_prof.home_lat, v_prof.home_lng);
  if v_problem is not null then update public.profiles set home_lat = null, home_lng = null where id = v_uid; end if;
  update public.profiles set is_student = true, university = v_uni.name, campus_location = v_campus.name, home_university_id = v_uni.id
   where id = v_uid;
  return jsonb_build_object('ok', true, 'is_student', true, 'university', v_uni.name, 'campus', v_campus.name,
    'needs_location', v_problem is not null, 'message', v_problem);
end $$;
revoke all on function public.set_my_student_status(boolean, uuid, uuid) from public, anon;
grant execute on function public.set_my_student_status(boolean, uuid, uuid) to authenticated;

-- ---------- 4. shop visibility ----------
-- may the signed-in viewer see an approved, published shop with this audience?
create or replace function public.store_audience_ok(p_store uuid, p_location_type text, p_availability text)
returns boolean language sql stable security definer set search_path = public as $$
  select p_location_type = 'off_campus' or p_availability = 'everyone'
      or exists (select 1 from public.profiles p join public.store_universities su on su.university_id = p.home_university_id
                  where p.id = auth.uid() and p.role = 'customer' and coalesce(p.is_student, false) and su.store_id = p_store)
      or (auth.uid() is not null and exists (select 1 from public.orders o where o.store_id = p_store and o.customer_id = auth.uid()))
$$;
grant execute on function public.store_audience_ok(uuid, text, text) to anon, authenticated;

drop policy if exists "stores select all" on public.stores;
drop policy if exists "stores select visible" on public.stores;
create policy "stores select visible" on public.stores for select using (
  public."current_role"() = 'developer'
  or manager_id = auth.uid()
  or id = public.current_store_id()
  or (status = 'approved' and is_published = true and public.store_audience_ok(id, location_type, availability))
);

-- menus follow the shop (the subquery uses the shop rule above)
drop policy if exists "menu select" on public.menu_items;
create policy "menu select" on public.menu_items for select using (
  (status = 'approved' and exists (select 1 from public.stores s where s.id = menu_items.store_id))
  or store_id = public.current_store_id()
  or public."current_role"() = 'developer'
);

-- a shop the customer can't see can't be ordered from, joined as a group, or contacted
create or replace function public.store_visible_to_me(p_store uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.stores s where s.id = p_store and s.status = 'approved' and s.is_published
                   and public.store_audience_ok(s.id, s.location_type, s.availability))
$$;
grant execute on function public.store_visible_to_me(uuid) to authenticated;

create or replace function public.enforce_order_shop_visible()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and new.customer_id = auth.uid() and not (coalesce(new.delivery_location, '{}'::jsonb) ? 'group_code')
     and not public.store_visible_to_me(new.store_id) then
    raise exception 'This shop isn''t available to your account.' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.enforce_order_shop_visible() from public, anon, authenticated;
drop trigger if exists trg_b4_order_shop_visible on public.orders;
create trigger trg_b4_order_shop_visible before insert on public.orders for each row execute function public.enforce_order_shop_visible();

create or replace function public.enforce_group_shop_visible()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.store_visible_to_me(new.store_id) then
    raise exception 'This shop isn''t available to your account.' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.enforce_group_shop_visible() from public, anon, authenticated;
drop trigger if exists trg_group_shop_visible on public.group_orders;
create trigger trg_group_shop_visible before insert on public.group_orders for each row execute function public.enforce_group_shop_visible();

create or replace function public.seller_contact(p_store_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select sp.whatsapp from public.seller_profiles sp
    join public.stores s on s.id = sp.store_id
   where sp.store_id = p_store_id and auth.uid() is not null
     and s.seller_kind = 'student'
     and ((s.status = 'approved' and s.is_published and public.store_audience_ok(s.id, s.location_type, s.availability))
          or (s.status <> 'archived' and exists (select 1 from public.orders o where o.store_id = p_store_id and o.customer_id = auth.uid())))
$$;
revoke all on function public.seller_contact(uuid) from public, anon;
grant execute on function public.seller_contact(uuid) to authenticated;

-- a student seller chooses who can order: students of their institution, or everyone
create or replace function public.set_my_shop_audience(p_audience text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_claims text := current_setting('request.jwt.claims', true); v_id uuid;
begin
  if p_audience not in ('university', 'everyone') then return jsonb_build_object('ok', false, 'error', 'Please choose who can order.'); end if;
  select id into v_id from public.stores where manager_id = auth.uid() and seller_kind = 'student' and archived_by is distinct from manager_id limit 1;
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'You don''t have a student shop.'); end if;
  perform set_config('request.jwt.claims', '', true);   -- availability is otherwise developer-only (protect_store_availability)
  update public.stores set availability = p_audience where id = v_id;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.set_my_shop_audience(text) from public, anon;
grant execute on function public.set_my_shop_audience(text) to authenticated;

-- campus shops with no institution linked: the developer fixes these (they stay hidden meanwhile)
create or replace function public.dev_unclassified_shops()
returns table (id uuid, name text, seller_kind text) language sql stable security definer set search_path = public as $$
  select s.id, s.name, s.seller_kind from public.stores s
   where public."current_role"() = 'developer' and s.status = 'approved' and s.location_type = 'campus' and s.availability = 'university'
     and not exists (select 1 from public.store_universities su where su.store_id = s.id)
   order by s.name
$$;
grant execute on function public.dev_unclassified_shops() to authenticated;

-- ---------- 5. Student Entrepreneurs for every institution with the feature ----------
create or replace function public.entrepreneur_email(p_user uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare v_email text; v_conf timestamptz; d public.allowed_domains;
begin
  select lower(email), email_confirmed_at into v_email, v_conf from auth.users where id = p_user;
  if v_email is not null and v_conf is not null then
    select * into d from public.allowed_domains where domain = public.email_domain_of(v_email) and active;
    if found and public.institution_feature(d.university_id, 'entrepreneurs')
       and (d.student_number_digits is null or public.student_number_from_email(v_email) is not null) then return v_email; end if;
  end if;
  select sv.email into v_email from public.student_verifications sv
    join public.allowed_domains ad on ad.domain = public.email_domain_of(sv.email) and ad.active
   where sv.user_id = p_user and sv.status = 'verified' and (sv.expires_at is null or sv.expires_at > now())
     and public.institution_feature(ad.university_id, 'entrepreneurs')
   order by sv.verified_at desc limit 1;
  return v_email;
end $$;
revoke all on function public.entrepreneur_email(uuid) from public, anon, authenticated;
-- keep the old per-domain switch in step (developer app now switches per institution)
update public.allowed_domains d set entrepreneur_eligible = public.institution_feature(d.university_id, 'entrepreneurs');

create or replace function public.my_entrepreneur_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); a public.entrepreneur_applications; v_pg text; v_shop uuid; v_prof public.profiles;
begin
  if v_uid is null then return jsonb_build_object('signed_in', false); end if;
  select * into v_prof from public.profiles where id = v_uid;
  select id into v_shop from public.stores where manager_id = v_uid and seller_kind = 'student' and archived_by is distinct from manager_id limit 1;
  select * into a from public.entrepreneur_applications where user_id = v_uid
   order by case when status in ('draft', 'pending_review', 'under_review', 'approved') then 0 else 1 end, updated_at desc limit 1;
  if a.id is not null then select population_group into v_pg from public.entrepreneur_demographics where application_id = a.id; end if;
  return jsonb_build_object(
    'signed_in', true,
    'is_student', coalesce(v_prof.is_student, false),
    'has_shop', v_shop is not null,
    'eligible_email', public.entrepreneur_email(v_uid),
    'programme_domains', (select coalesce(jsonb_agg(jsonb_build_object('domain', d.domain, 'institution', u.name, 'university_id', u.id, 'digits', d.student_number_digits, 'prefix', d.student_number_prefix) order by u.name), '[]'::jsonb)
                            from public.allowed_domains d join public.universities u on u.id = d.university_id
                           where d.active and public.institution_feature(u.id, 'entrepreneurs')),
    'versions', public.legal_versions(),
    'application', case when a.id is null then null else
      (to_jsonb(a) - 'reviewed_by' - 'decision_reason' - 'reason_visible')
      || jsonb_build_object('decision_reason', case when a.reason_visible then a.decision_reason end, 'population_group', v_pg) end);
end $$;
revoke all on function public.my_entrepreneur_status() from public, anon;
grant execute on function public.my_entrepreneur_status() to authenticated;

-- student accounts only (the save function itself stays as in student_entrepreneurs.sql)
create or replace function public.entrepreneur_student_only()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not exists (select 1 from public.profiles where id = new.user_id and coalesce(is_student, false)) then
    raise exception 'The Student Entrepreneur Programme is for student accounts.' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.entrepreneur_student_only() from public, anon, authenticated;
drop trigger if exists trg_entrepreneur_student_only on public.entrepreneur_applications;
create trigger trg_entrepreneur_student_only before insert on public.entrepreneur_applications
  for each row execute function public.entrepreneur_student_only();

-- ---------- 6. campus buildings: students of that institution ----------
drop policy if exists "campus venues read" on public.campus_venues;
create policy "campus venues read" on public.campus_venues for select to authenticated using (
  public."current_role"() = 'developer'
  or (active and verification = 'verified_current' and exists (
        select 1 from public.campuses c join public.profiles p on p.home_university_id = c.university_id
         where c.id = campus_venues.campus_id and p.id = auth.uid() and coalesce(p.is_student, false)))
);
revoke select on public.campus_venues from anon;

-- ---------- 7. developer: institutions and campuses ----------
create or replace function public.dev_save_institution(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid := p_id; v_name text := btrim(coalesce(p->>'name', '')); v_code text := upper(regexp_replace(coalesce(p->>'short_code', ''), '[^A-Za-z0-9]', '', 'g'));
begin
  if public."current_role"() is distinct from 'developer' then return jsonb_build_object('ok', false, 'error', 'Not allowed.'); end if;
  if length(v_name) < 3 or length(v_name) > 120 then return jsonb_build_object('ok', false, 'error', 'Enter the official name (3 to 120 characters).'); end if;
  if length(v_code) < 2 or length(v_code) > 12 then return jsonb_build_object('ok', false, 'error', 'Enter a short code of 2 to 12 letters or numbers.'); end if;
  if v_id is null then
    insert into public.universities (name, short_code, active, registration_open, features)
    values (v_name, v_code, coalesce((p->>'active')::boolean, true), coalesce((p->>'registration_open')::boolean, false),
            jsonb_build_object('orientation', coalesce((p->'features'->>'orientation')::boolean, false), 'entrepreneurs', coalesce((p->'features'->>'entrepreneurs')::boolean, false)))
    returning id into v_id;
  else
    update public.universities set name = v_name, short_code = v_code,
      active = coalesce((p->>'active')::boolean, active), registration_open = coalesce((p->>'registration_open')::boolean, registration_open),
      features = features || jsonb_strip_nulls(jsonb_build_object('orientation', (p->'features'->>'orientation')::boolean, 'entrepreneurs', (p->'features'->>'entrepreneurs')::boolean))
     where id = v_id;
    if not found then return jsonb_build_object('ok', false, 'error', 'Institution not found.'); end if;
    update public.allowed_domains set institution_name = v_name where university_id = v_id and institution_name is distinct from v_name;
    update public.allowed_domains d set entrepreneur_eligible = public.institution_feature(v_id, 'entrepreneurs') where d.university_id = v_id;
  end if;
  begin perform public.ops_audit_add(null, 'developer', auth.uid(), 'institution_save', 'saved', jsonb_build_object('institution', v_id)); exception when others then null; end;
  return jsonb_build_object('ok', true, 'id', v_id);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'An institution with that name or short code already exists.');
end $$;
revoke all on function public.dev_save_institution(uuid, jsonb) from public, anon;
grant execute on function public.dev_save_institution(uuid, jsonb) to authenticated;

create or replace function public.dev_save_campus(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid := p_id; v_uni uuid := nullif(p->>'university_id', '')::uuid; v_name text := btrim(coalesce(p->>'name', ''));
        v_code text; v_ver text := coalesce(nullif(p->>'verification', ''), 'unverified'); v_src text := nullif(btrim(coalesce(p->>'source_url', '')), '');
begin
  if public."current_role"() is distinct from 'developer' then return jsonb_build_object('ok', false, 'error', 'Not allowed.'); end if;
  if length(v_name) < 2 or length(v_name) > 80 then return jsonb_build_object('ok', false, 'error', 'Enter the campus name.'); end if;
  if v_ver not in ('verified_current', 'historical_unknown', 'unverified', 'closed') then return jsonb_build_object('ok', false, 'error', 'Choose a status.'); end if;
  if v_ver = 'verified_current' and v_src is null then return jsonb_build_object('ok', false, 'error', 'A verified campus needs a source URL.'); end if;
  if v_id is null then
    if not exists (select 1 from public.universities where id = v_uni) then return jsonb_build_object('ok', false, 'error', 'Choose the institution.'); end if;
    v_code := lower((select short_code from public.universities where id = v_uni)) || '-' || trim(both '-' from regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'));
    insert into public.campuses (university_id, code, name, full_name, address, address_verified, source_url, notes, verification, last_verified, active, sort)
    values (v_uni, v_code, v_name, coalesce(nullif(btrim(p->>'full_name'), ''), v_name || ' Campus'), nullif(btrim(coalesce(p->>'address', '')), ''),
            coalesce((p->>'address_verified')::boolean, false), v_src, nullif(btrim(coalesce(p->>'notes', '')), ''), v_ver,
            case when v_src is not null then current_date end, coalesce((p->>'active')::boolean, true),
            coalesce((select max(sort) + 10 from public.campuses where university_id = v_uni), 10))
    returning id into v_id;
  else
    update public.campuses set name = v_name, full_name = coalesce(nullif(btrim(p->>'full_name'), ''), full_name),
      address = nullif(btrim(coalesce(p->>'address', '')), ''), address_verified = coalesce((p->>'address_verified')::boolean, address_verified),
      source_url = v_src, verification = v_ver, active = coalesce((p->>'active')::boolean, active),
      last_verified = case when v_src is distinct from source_url then current_date else last_verified end, updated_at = now()
     where id = v_id;
    if not found then return jsonb_build_object('ok', false, 'error', 'Campus not found.'); end if;
  end if;
  begin perform public.ops_audit_add(null, 'developer', auth.uid(), 'campus_save', 'saved', jsonb_build_object('campus', v_id)); exception when others then null; end;
  return jsonb_build_object('ok', true, 'id', v_id);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'That campus already exists for this institution.');
end $$;
revoke all on function public.dev_save_campus(uuid, jsonb) from public, anon;
grant execute on function public.dev_save_campus(uuid, jsonb) to authenticated;
