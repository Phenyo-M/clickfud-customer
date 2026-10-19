-- ============================================================
-- ClickFood: full student shop application (2026-10-12)
-- Runs after seller_review_address.sql and account_deletion.sql.
--
-- The developer's application view shows the same questions for every
-- shop. Student sellers now answer them too: business type, business
-- phone and email, registered business (+ date), their own phone and
-- role, operating days and hours, and what food they sell. Description
-- becomes required. All of it is checked here, not only in the app.
--
-- become_student_seller() gains one argument, p_details jsonb:
--   { business_type, contact_phone, contact_email, is_registered,
--     registration_date, manager_phone, manager_position,
--     open_days: [0..6], opening_time "HH:MM", closing_time "HH:MM",
--     products_summary }
-- Safe to run more than once.
-- ============================================================

drop function if exists public.become_student_seller(text, text, text[], text, text, text, text, text, text, double precision, double precision, boolean, boolean);

create or replace function public.student_business_types()
returns text[] language sql immutable as $$ select array['fast_food', 'kota_shop', 'takeaway', 'bakery', 'other']::text[] $$;

-- Shared checks for the extra application answers (setup and later edits).
create or replace function public.check_student_shop_details(d jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_type text := nullif(btrim(coalesce(d->>'business_type', '')), '');
  v_phone text := public.normalize_sa_whatsapp(d->>'contact_phone');
  v_mphone text := public.normalize_sa_whatsapp(d->>'manager_phone');
  v_email text := lower(btrim(coalesce(d->>'contact_email', '')));
  v_pos text := nullif(btrim(coalesce(d->>'manager_position', '')), '');
  v_reg boolean := coalesce((d->>'is_registered')::boolean, false);
  v_regdate date;
  v_days int[];
  v_open time; v_close time;
  v_summary text := btrim(left(coalesce(d->>'products_summary', ''), 300));
begin
  if v_type is null or not (v_type = any (public.student_business_types())) then raise exception 'Please choose your business type.'; end if;
  if v_phone is null then raise exception 'Please enter a valid business phone number.'; end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'Please enter a valid business email address.'; end if;
  if v_mphone is null then raise exception 'Please enter a valid phone number for yourself.'; end if;
  if v_pos is null or v_pos not in ('owner', 'manager', 'other') then raise exception 'Please choose your role in the business.'; end if;
  if v_reg then
    begin v_regdate := (d->>'registration_date')::date; exception when others then v_regdate := null; end;
    if v_regdate is null or v_regdate > current_date then raise exception 'Please enter the date your business was registered.'; end if;
  end if;
  select array_agg(distinct x::int order by x::int) into v_days
    from jsonb_array_elements_text(coalesce(d->'open_days', '[]'::jsonb)) x where x ~ '^[0-6]$';
  if v_days is null then raise exception 'Please choose the days you sell.'; end if;
  begin v_open := (d->>'opening_time')::time; v_close := (d->>'closing_time')::time;
  exception when others then v_open := null; end;
  if v_open is null or v_close is null then raise exception 'Please enter your opening and closing times.'; end if;
  if length(v_summary) < 3 then raise exception 'Please say what food you sell.'; end if;
  if coalesce(public.non_food_word(v_summary), public.alcohol_word(v_summary)) is not null then
    raise exception 'ClickFood is for food sellers only.';
  end if;
  return jsonb_build_object('business_type', v_type, 'contact_phone', v_phone, 'contact_email', v_email,
    'manager_phone', v_mphone, 'manager_position', v_pos, 'is_registered', v_reg, 'registration_date', v_regdate,
    'closed_days', (select coalesce(array_agg(g), '{}') from generate_series(0, 6) g where not (g = any (v_days))),
    'opening_time', v_open, 'closing_time', v_close, 'products_summary', v_summary);
end $$;

create or replace function public.become_student_seller(
  p_business_name text, p_whatsapp text, p_categories text[], p_other_food text,
  p_campus text, p_description text, p_logo_url text, p_cover_url text,
  p_address text, p_lat double precision, p_lng double precision,
  p_hustleup boolean, p_accept_rules boolean, p_details jsonb)
returns public.stores
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_prof public.profiles;
  v_user record;
  v_name text := btrim(coalesce(p_business_name, ''));
  v_wa text := public.normalize_sa_whatsapp(p_whatsapp);
  v_cats text[];
  v_other text := nullif(btrim(left(coalesce(p_other_food, ''), 120)), '');
  v_campus text := nullif(btrim(coalesce(p_campus, '')), '');
  v_cover text := nullif(btrim(left(coalesce(p_cover_url, ''), 500)), '');
  v_address text := btrim(left(coalesce(p_address, ''), 160));
  v_desc text := btrim(left(coalesce(p_description, ''), 300));
  v_claims text := current_setting('request.jwt.claims', true);
  v_slug text;
  d jsonb;
  s public.stores;
begin
  if v_uid is null then raise exception 'Please sign in first.'; end if;
  select * into v_prof from public.profiles where id = v_uid;
  if not found or v_prof.role <> 'customer' or not coalesce(v_prof.active, true) then
    raise exception 'Only student accounts can open a student food shop.';
  end if;
  select email, email_confirmed_at into v_user from auth.users where id = v_uid;
  if not public.is_up_student_email(v_user.email) then
    raise exception 'Student entrepreneur registration requires an official University of Pretoria student email address.';
  end if;
  if v_user.email_confirmed_at is null then raise exception 'Please verify your email address first.'; end if;
  -- a shop the student closed themselves (account_deletion.sql) doesn't count
  if exists (select 1 from public.stores where manager_id = v_uid and archived_by is distinct from manager_id) then raise exception 'You already have a shop.'; end if;
  if length(v_name) < 2 or length(v_name) > 60 then
    raise exception 'Please enter your food business name (2 to 60 characters).';
  end if;
  if coalesce(public.non_food_word(v_name), public.alcohol_word(v_name)) is not null then
    raise exception 'ClickFood is for food sellers only.';
  end if;
  if v_wa is null then raise exception 'Please enter a valid South African WhatsApp number.'; end if;
  select array_agg(distinct c) into v_cats from unnest(coalesce(p_categories, '{}')) c where c is not null;
  if v_cats is null or not (v_cats <@ public.student_food_categories()) then
    raise exception 'Please choose the food categories you sell.';
  end if;
  if 'Other Food' = any (v_cats) and v_other is null then raise exception 'Please say what other food you sell.'; end if;
  if public.non_food_word(v_other) is not null then raise exception 'ClickFood is for food sellers only.'; end if;
  if length(v_desc) < 10 then raise exception 'Please describe your food business (at least 10 characters).'; end if;
  if v_campus is null or not (v_campus = any (array['Hatfield', 'Hillcrest', 'Groenkloof', 'Prinshof', 'Mamelodi', 'Onderstepoort', 'GIBS'])) then
    raise exception 'Please choose your campus.';
  end if;
  if v_cover is null or v_cover !~ '^https://' then raise exception 'Please add a photo of your shop.'; end if;
  if length(v_address) < 5 then raise exception 'Please enter your pickup address.'; end if;
  if p_lat is null or p_lng is null or not public.pin_in_sa(p_lat, p_lng) then
    raise exception 'Please put your pickup point on the map.';
  end if;
  if p_hustleup is null then raise exception 'Please say if you are a hustleUP member.'; end if;
  d := public.check_student_shop_details(coalesce(p_details, '{}'::jsonb));
  if not coalesce(p_accept_rules, false) then raise exception 'Please accept the seller rules.'; end if;

  v_slug := trim(both '-' from regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g')) || '-' || substr(replace(v_uid::text, '-', ''), 1, 6);

  perform set_config('request.jwt.claims', '', true);
  insert into public.stores (manager_id, name, slug, description, category, logo_url, cover_image_url, campus_location, address,
                             pickup_lat, pickup_lng, university, seller_kind, status, is_published, commission_percent,
                             accepts_delivery, accepts_collection, delivery_fee, prep_time_min, prep_time_max,
                             opening_time, closing_time, closed_days, weekly_hours, business_type,
                             contact_phone, contact_email, is_registered_business, registration_date,
                             manager_phone, manager_position, products_summary,
                             product_categories, terms_accepted_at, manager_name, manager_email)
  values (v_uid, v_name, v_slug, v_desc, 'Student Food',
          nullif(btrim(left(coalesce(p_logo_url, ''), 500)), ''), v_cover, v_campus, v_address,
          p_lat, p_lng, 'University of Pretoria', 'student', 'pending', false, 0,
          false, true, 0, 10, 30,
          (d->>'opening_time')::time, (d->>'closing_time')::time,
          (select coalesce(array_agg(x::int), '{}') from jsonb_array_elements_text(d->'closed_days') x), null, d->>'business_type',
          d->>'contact_phone', d->>'contact_email', (d->>'is_registered')::boolean, nullif(d->>'registration_date', '')::date,
          d->>'manager_phone', d->>'manager_position', d->>'products_summary',
          v_cats, now(), v_prof.name, v_user.email)
  returning * into s;
  insert into public.seller_profiles (store_id, owner_id, whatsapp, food_categories, other_food, rules_accepted_at, hustleup_member)
  values (s.id, v_uid, v_wa, v_cats, case when 'Other Food' = any (v_cats) then v_other end, now(), p_hustleup);
  update public.profiles set store_id = s.id where id = v_uid and store_id is null;
  insert into public.notifications (user_id, message, type)
  select id, 'New student shop to review: ' || v_name || case when p_hustleup then ' (hustleUP member)' else '' end || '.', 'store_review'
    from public.profiles where role = 'developer';
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return s;
end $$;
revoke all on function public.become_student_seller(text, text, text[], text, text, text, text, text, text, double precision, double precision, boolean, boolean, jsonb) from public, anon;
grant execute on function public.become_student_seller(text, text, text[], text, text, text, text, text, text, double precision, double precision, boolean, boolean, jsonb) to authenticated;

-- Editing the same answers later (Shop tab).
create or replace function public.update_student_shop_details(p_description text, p_details jsonb)
returns public.stores language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.current_seller_store_id();
  v_desc text := btrim(left(coalesce(p_description, ''), 300));
  d jsonb;
  s public.stores;
begin
  if v_store is null then raise exception 'You don''t have a student shop.'; end if;
  if length(v_desc) < 10 then raise exception 'Please describe your food business (at least 10 characters).'; end if;
  d := public.check_student_shop_details(coalesce(p_details, '{}'::jsonb));
  update public.stores set
    description = v_desc, business_type = d->>'business_type',
    contact_phone = d->>'contact_phone', contact_email = d->>'contact_email',
    is_registered_business = (d->>'is_registered')::boolean, registration_date = nullif(d->>'registration_date', '')::date,
    manager_phone = d->>'manager_phone', manager_position = d->>'manager_position', products_summary = d->>'products_summary',
    opening_time = (d->>'opening_time')::time, closing_time = (d->>'closing_time')::time,
    closed_days = (select coalesce(array_agg(x::int), '{}') from jsonb_array_elements_text(d->'closed_days') x)
   where id = v_store returning * into s;
  return s;
end $$;
revoke all on function public.update_student_shop_details(text, jsonb) from public, anon;
grant execute on function public.update_student_shop_details(text, jsonb) to authenticated;
