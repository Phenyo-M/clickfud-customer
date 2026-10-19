-- Rollback for open_signup_students.sql (built from the live definitions, 2026-10-17).
-- Restores the student-email-only sign-up. Student verification records,
-- deal claims and the new columns are dropped; existing accounts and orders stay.
drop trigger if exists trg_promo_claim_record on public.orders;
drop function if exists public.promo_claim_record();
drop trigger if exists trg_c0_promo_claim_check on public.orders;
drop function if exists public.promo_claim_check();
drop function if exists public.promo_customer_check(text, uuid);
drop function if exists public.check_my_promo(text, numeric);
drop function if exists public.promo_customer_block_reason(text, uuid);
drop table if exists public.promo_claims;
alter table public.promotions drop constraint if exists promotions_audience_check;
alter table public.promotions drop constraint if exists promotions_per_customer_check;
alter table public.promotions drop column if exists audience, drop column if exists per_customer_limit, drop column if exists university_id, drop column if exists campus_id;
drop function if exists public.dev_review_student(uuid, text, text);
drop function if exists public.student_verify_confirm(uuid, text);
drop function if exists public.student_verify_start(uuid, text, uuid, uuid, text);
drop function if exists public.my_student_verification();
drop function if exists public.is_verified_student(uuid);
drop table if exists public.student_verifications;
drop function if exists public.set_my_student_status(boolean, uuid, uuid);
alter table public.profiles drop column if exists is_student;
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_requested_role text;
  v_role text;
  v_status text;
  v_student_number text;
begin
  v_requested_role := coalesce(new.raw_user_meta_data->>'role', 'customer');
  v_status := 'approved';

  if v_requested_role = 'developer' then
    if exists (select 1 from public.profiles where role = 'developer') then
      v_role := 'customer';
    else
      v_role := 'developer';
    end if;
  elsif v_requested_role = 'manager' then
    v_role := 'manager';
  elsif v_requested_role = 'driver' then
    v_role := 'driver';
    v_status := 'pending';
  else
    v_role := 'customer';
  end if;

  -- Normalise "U12345678" / "12345678" / " u1234 5678 " -> "u12345678".
  -- Only "u" + digits/spaces is accepted; anything else counts as missing.
  -- Nobody types it any more (2026-10-14): it comes from the UP email
  -- (u12345678@tuks.co.za -> u12345678); a number typed in an older app is
  -- only used if the email has none (such a sign-up is refused anyway).
  v_student_number := lower(coalesce(public.student_number_from_email(new.email), nullif(btrim(new.raw_user_meta_data->>'student_number'), ''), ''));
  if v_student_number ~ '^\s*u?[0-9\s]+$' then
    v_student_number := 'u' || regexp_replace(v_student_number, '[^0-9]', '', 'g');
  else
    v_student_number := null;
  end if;

  if v_student_number is not null and v_student_number !~ '^u[0-9]{8}$' then
    v_student_number := null; -- never let a malformed value block a non-customer sign-up
  end if;
  -- the student email's own number wins (format per institution, allowed_domains)
  v_student_number := coalesce(public.student_number_from_email(new.email), v_student_number);

  insert into public.profiles (id, name, email, role, phone, store_id, university, campus_location, status, avatar_url, student_number)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
    new.email,
    v_role,
    new.raw_user_meta_data->>'phone',
    null,
    coalesce(case when v_role = 'customer' then public.university_of_email(new.email) end, new.raw_user_meta_data->>'university'),
    new.raw_user_meta_data->>'campus_location',
    v_status,
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture'),
    case when v_role = 'customer' then v_student_number else null end
  )
  on conflict (id) do nothing;

  return new;
end;
$function$;
-- rollback: the live become_student_seller before 2026-10-17
CREATE OR REPLACE FUNCTION public.become_student_seller(p_business_name text, p_whatsapp text, p_categories text[], p_other_food text, p_campus text, p_description text, p_logo_url text, p_cover_url text, p_address text, p_lat double precision, p_lng double precision, p_hustleup boolean, p_accept_rules boolean, p_details jsonb)
 RETURNS stores
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    raise exception 'Student entrepreneur registration requires your student email address.';
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
  -- the institution's own campuses; an institution with no campus list takes any campus name
  if v_campus is null or (cardinality(public.university_campuses(public.university_of_email(v_user.email))) > 0
                          and not (v_campus = any (public.university_campuses(public.university_of_email(v_user.email))))) then
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
          p_lat, p_lng, coalesce(public.university_of_email(v_user.email), 'University of Pretoria'), 'student', 'pending', false, 0,
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
end $function$;
drop trigger if exists trg_enforce_customer_signup on auth.users;
drop trigger if exists trg_enforce_customer_email_change on auth.users;
drop trigger if exists trg_lock_student_university on public.profiles;
CREATE TRIGGER trg_enforce_customer_email_change BEFORE UPDATE OF email, email_change ON auth.users FOR EACH ROW EXECUTE FUNCTION enforce_customer_email_change();
CREATE CONSTRAINT TRIGGER trg_enforce_customer_signup AFTER INSERT ON auth.users DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_customer_signup();
CREATE TRIGGER trg_lock_student_university BEFORE INSERT OR UPDATE OF university, email, role ON public.profiles FOR EACH ROW EXECUTE FUNCTION lock_student_university();
