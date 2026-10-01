-- ============================================================
-- NEW (2026-09-29) — CUSTOMER accounts restricted to verified University
-- of Pretoria student emails; student number collected at sign-up.
--
-- WHY HERE: customer sign-up goes from the browser straight to Supabase
-- Auth, so the database is the only server-side point every sign-up
-- (email form, direct API call, Google OAuth) must pass through.
-- handle_new_user() already decides each new account's role; the rule is
-- applied right after that decision, ONLY when the result is 'customer'.
-- Raising an exception there rolls back the whole sign-up: no auth user,
-- no profile, no confirmation email.
--
-- WHAT IS AND ISN'T CHECKED:
--   - email must end in an approved UP student domain (up_student_email_
--     domains() — the ONE authoritative list; js/config.js mirrors it for
--     on-screen messages only).
--   - ownership of that email is proven by Supabase's existing
--     confirmation link — unconfirmed accounts cannot sign in.
--   - student number: required and format-checked (u + 8 digits). It is
--     SELF-REPORTED — nothing here claims UP has confirmed the student is
--     currently registered. No UP systems are contacted.
--
-- OTHER ROLES — UNCHANGED:
--   - manager / driver / first-developer sign-ups resolve to their own
--     role and are not affected.
--   - accounts created by an ADMIN are exempt: kitchen staff
--     (create-kitchen-staff, admin API) and dispatchers created by hand in
--     the Supabase dashboard. They are the only accounts that exist
--     already-confirmed at the moment of creation (email provider +
--     email_confirmed_at set) — a normal sign-up cannot do that while the
--     project's "Confirm email" setting is ON. KEEP IT ON: turning it off
--     would make ordinary sign-ups look admin-created and skip this rule.
--
-- EXISTING ACCOUNTS: nothing is deleted or altered. Existing non-UP
-- customers are refused at customer-app sign-in (secure-login + app),
-- per the product decision to apply the rule to everyone.
-- Safe to run more than once.
-- ============================================================

-- 1. The single authoritative list of approved student email domains.
create or replace function public.up_student_email_domains()
returns text[]
language sql
immutable
as $$ select array['tuks.co.za']::text[] $$;

create or replace function public.is_up_student_email(p_email text)
returns boolean
language sql
immutable
as $$
  select p_email is not null
     and lower(btrim(p_email)) ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'
     and split_part(lower(btrim(p_email)), '@', 2) = any (public.up_student_email_domains())
$$;
grant execute on function public.up_student_email_domains() to anon, authenticated;
grant execute on function public.is_up_student_email(text) to anon, authenticated;

-- 2. Student number on the profile (new, nullable: existing rows untouched).
alter table public.profiles add column if not exists student_number text;
do $$ begin
  alter table public.profiles add constraint profiles_student_number_format
    check (student_number is null or student_number ~ '^u[0-9]{8}$');
exception when duplicate_object then null; end $$;

-- 3. handle_new_user(): IDENTICAL role logic to the live version, plus the
--    customer-only rule and storing the student number.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
$$;

-- 3b. THE ENFORCEMENT — a deferred check, run at the END of the sign-up
--     transaction (not at the first INSERT).
--
--     Why deferred: Supabase inserts every new auth user unconfirmed and
--     only then, still inside the same transaction, either marks it
--     confirmed (admin-created: create-kitchen-staff, dashboard "Add user"
--     with auto-confirm) or records the confirmation email (normal
--     sign-up). At INSERT time the two look identical; at COMMIT they
--     don't. Raising here aborts the whole transaction — no auth user, no
--     profile, and the confirmation email is never sent.
--
--     Applies only when the account's role ended up 'customer':
--       - provider 'email' + still unconfirmed at commit = a real sign-up
--         -> needs a UP student email AND a valid student number;
--       - any other provider (Google…) -> needs a UP student email (the
--         student number is asked once in the app: no form on that path);
--       - provider 'email' + already confirmed at commit = created by an
--         admin -> exempt (kitchen staff, dispatchers). A normal sign-up
--         can't be confirmed at commit while "Confirm email" is ON.
create or replace function public.enforce_customer_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
$$;
drop trigger if exists trg_enforce_customer_signup on auth.users;
create constraint trigger trg_enforce_customer_signup
  after insert on auth.users
  deferrable initially deferred
  for each row execute function public.enforce_customer_signup();

-- 4. A customer can't move their account to a non-UP email afterwards.
create or replace function public.enforce_customer_email_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
$$;
drop trigger if exists trg_enforce_customer_email_change on auth.users;
create trigger trg_enforce_customer_email_change
  before update of email, email_change on auth.users
  for each row execute function public.enforce_customer_email_change();
