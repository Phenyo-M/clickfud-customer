-- Undo allowed_domains.sql: functions back to their previous live versions.
-- The allowed_domains table is kept (drop it by hand if wanted).
drop trigger if exists trg_a0_require_verified_email on public.orders;
drop function if exists public.require_verified_email_for_order();
drop trigger if exists trg_lock_student_university on public.profiles;
drop function if exists public.lock_student_university();
CREATE OR REPLACE FUNCTION public.up_student_email_domains()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$ select array['tuks.co.za']::text[] $function$;

CREATE OR REPLACE FUNCTION public.is_up_student_email(p_email text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select p_email is not null
     and lower(btrim(p_email)) ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'
     and split_part(lower(btrim(p_email)), '@', 2) = any (public.up_student_email_domains())
$function$;

CREATE OR REPLACE FUNCTION public.student_number_from_email(p_email text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when lower(split_part(coalesce(p_email, ''), '@', 1)) ~ '^u?[0-9]{8}$'
              then 'u' || regexp_replace(split_part(p_email, '@', 1), '[^0-9]', '', 'g') end
$function$;

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

  insert into public.profiles (id, name, email, role, phone, store_id, university, campus_location, status, avatar_url, student_number)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
    new.email,
    v_role,
    new.raw_user_meta_data->>'phone',
    null,
    new.raw_user_meta_data->>'university',
    new.raw_user_meta_data->>'campus_location',
    v_status,
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture'),
    case when v_role = 'customer' then v_student_number else null end
  )
  on conflict (id) do nothing;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_customer_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user record;
  v_role text;
  v_student_number text;
  v_provider text;
begin
  -- A deferred trigger's NEW is the row as first inserted; read the final state.
  select id, email, email_confirmed_at, raw_app_meta_data into v_user from auth.users where id = new.id;
  if not found then return null; end if;
  select role, student_number into v_role, v_student_number from public.profiles where id = new.id;
  if coalesce(v_role, 'customer') <> 'customer' then return null; end if;

  v_provider := coalesce(v_user.raw_app_meta_data->>'provider', 'email');
  if v_provider = 'email' and v_user.email_confirmed_at is not null then
    return null; -- created by an admin (see above)
  end if;

  if not public.is_up_student_email(v_user.email) then
    raise exception 'UP_STUDENT_EMAIL_REQUIRED: customer accounts need a University of Pretoria student email'
      using errcode = 'check_violation';
  end if;
  -- The UP email must itself be the student number (u12345678@tuks.co.za);
  -- any other UP address is refused, whatever the app sends (2026-10-14).
  if public.student_number_from_email(v_user.email) is null then
    raise exception 'UP_STUDENT_NUMBER_REQUIRED: the UP student email must be your student number (u12345678@tuks.co.za)'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_customer_email_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if exists (select 1 from public.profiles p where p.id = new.id and p.role = 'customer') then
    if new.email is distinct from old.email and not public.is_up_student_email(new.email) then
      raise exception 'UP_STUDENT_EMAIL_REQUIRED: customer accounts need a University of Pretoria student email'
        using errcode = 'check_violation';
    end if;
    if new.email_change is distinct from old.email_change and coalesce(new.email_change, '') <> ''
       and not public.is_up_student_email(new.email_change) then
      raise exception 'UP_STUDENT_EMAIL_REQUIRED: customer accounts need a University of Pretoria student email'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$function$;

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
end $function$;

alter table public.profiles drop constraint if exists profiles_student_number_format;
alter table public.profiles add constraint profiles_student_number_format
  check (student_number is null or student_number ~ '^u[0-9]{8}$') not valid;
drop function if exists public.is_signup_email_allowed(text);
drop function if exists public.student_number_required(text);
drop function if exists public.university_of_email(text);
drop function if exists public.university_campuses(text);
drop function if exists public.email_domain_of(text);
