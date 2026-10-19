-- Undo student_number_from_email.sql: the two functions go back to their
-- previous live versions (filled-in student numbers are kept).
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
  v_student_number := lower(coalesce(new.raw_user_meta_data->>'student_number', ''));
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
  if v_provider = 'email' and (v_student_number is null or v_student_number !~ '^u[0-9]{8}$') then
    raise exception 'UP_STUDENT_NUMBER_REQUIRED: a valid student number is required'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$function$;

drop function if exists public.student_number_from_email(text);
