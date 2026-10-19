-- ============================================================
-- CLICKFOOD, open sign-up + student status + student verification +
-- student-only deals (2026-10-17). Needs multi_university.sql and
-- tut_campuses.sql first.
--
-- 1. Anyone can create a customer account with an email they can verify
--    (Gmail, Outlook, university, ...). Supabase still makes them confirm
--    the email. The student-email sign-up rules are switched off (their code
--    stays for the rollback).
-- 2. profiles.is_student: asked once after sign-in ("Are you a student?").
--    University + campus are the student's own choice now (no longer forced
--    from the login email). Choosing a university is NOT student proof.
-- 3. student_verifications: a separate university email, proved by a link
--    sent to it (token kept only as a hash). Checked and changed only by
--    the server (Edge Function student-verify, service role). Valid until a
--    developer revokes it (owner's choice, 2026-10-17). Emails from
--    institutions not on the Supported Institutions list need a developer's
--    approval after the link is opened.
-- 4. Deals (promotions): audience everyone | students, a per-customer limit,
--    optional university / campus. Enforced when the order is saved, with a
--    per-customer lock so parallel orders can't go over a limit, and every
--    successful claim recorded in promo_claims.
-- Existing accounts, orders and codes are kept. Safe to run more than once.
-- ============================================================

-- ---------- 1. open sign-up ----------
drop trigger if exists trg_enforce_customer_signup on auth.users;
drop trigger if exists trg_enforce_customer_email_change on auth.users;
drop trigger if exists trg_lock_student_university on public.profiles;

-- new profiles: university only if the app sent one (it no longer does);
-- otherwise unchanged from the live version
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_requested_role text;
  v_role text;
  v_status text;
begin
  v_requested_role := coalesce(new.raw_user_meta_data->>'role', 'customer');
  v_status := 'approved';
  if v_requested_role = 'developer' then
    if exists (select 1 from public.profiles where role = 'developer') then v_role := 'customer'; else v_role := 'developer'; end if;
  elsif v_requested_role = 'manager' then
    v_role := 'manager';
  elsif v_requested_role = 'driver' then
    v_role := 'driver'; v_status := 'pending';
  else
    v_role := 'customer';
  end if;
  insert into public.profiles (id, name, email, role, phone, store_id, university, campus_location, status, avatar_url, student_number)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.email, v_role, new.raw_user_meta_data->>'phone', null,
    nullif(btrim(coalesce(new.raw_user_meta_data->>'university', '')), ''),
    nullif(btrim(coalesce(new.raw_user_meta_data->>'campus_location', '')), ''),
    v_status,
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture'),
    case when v_role = 'customer' then public.student_number_from_email(new.email) else null end
  )
  on conflict (id) do nothing;
  return new;
end;
$function$;

-- ---------- 2. student status ----------
alter table public.profiles add column if not exists is_student boolean;
-- existing customers who already chose a university were students: don't ask again
update public.profiles set is_student = true where role = 'customer' and is_student is null and university is not null;

create or replace function public.set_my_student_status(p_is_student boolean, p_university uuid default null, p_campus uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_uni public.universities; v_campus public.campuses;
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid and role = 'customer') then
    return jsonb_build_object('ok', false, 'error', 'Please sign in.');
  end if;
  if p_is_student is null then return jsonb_build_object('ok', false, 'error', 'Please choose an answer.'); end if;
  if not p_is_student then
    update public.profiles set is_student = false, university = null, campus_location = null, home_university_id = null, preferred_venue_id = null where id = v_uid;
    return jsonb_build_object('ok', true, 'is_student', false);
  end if;
  select * into v_uni from public.universities where id = p_university and active;
  if not found then return jsonb_build_object('ok', false, 'error', 'Please choose your university.'); end if;
  if p_campus is not null then
    select * into v_campus from public.campuses where id = p_campus and university_id = v_uni.id and active;
    if not found then return jsonb_build_object('ok', false, 'error', 'Please choose a campus of your university.'); end if;
  elsif exists (select 1 from public.campuses where university_id = v_uni.id and active) then
    return jsonb_build_object('ok', false, 'error', 'Please choose your campus.');
  end if;
  update public.profiles set is_student = true, university = v_uni.name, campus_location = v_campus.name, home_university_id = v_uni.id
   where id = v_uid;
  return jsonb_build_object('ok', true, 'is_student', true, 'university', v_uni.name, 'campus', v_campus.name);
end $$;
revoke all on function public.set_my_student_status(boolean, uuid, uuid) from public, anon;
grant execute on function public.set_my_student_status(boolean, uuid, uuid) to authenticated;

-- ---------- 3. student verification ----------
create table if not exists public.student_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and email ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'),
  university_id uuid references public.universities(id) on delete set null,
  campus_id uuid references public.campuses(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'needs_review', 'verified', 'rejected', 'revoked', 'expired')),
  token_hash text,                    -- sha-256 of the emailed token; the token itself is never stored
  token_expires_at timestamptz,
  send_count int not null default 0,
  last_sent_at timestamptz,
  confirm_attempts int not null default 0,
  verified_at timestamptz,
  expires_at timestamptz,             -- null = until revoked
  reviewed_by uuid references public.profiles(id) on delete set null,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists student_verifications_user on public.student_verifications (user_id, status);
-- one university email can prove ONE account
create unique index if not exists student_verifications_email_once on public.student_verifications (email) where status in ('verified', 'needs_review');
-- one open request per account
create unique index if not exists student_verifications_one_pending on public.student_verifications (user_id) where status = 'pending';
alter table public.student_verifications enable row level security;
revoke all on public.student_verifications from anon, authenticated;
-- the student sees their own record, never the token hash
grant select (id, user_id, email, university_id, campus_id, status, last_sent_at, verified_at, expires_at, created_at) on public.student_verifications to authenticated;
drop policy if exists "student verifications own" on public.student_verifications;
create policy "student verifications own" on public.student_verifications for select to authenticated
  using (user_id = auth.uid() or public."current_role"() = 'developer');

create or replace function public.is_verified_student(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.student_verifications v where v.user_id = p_user and v.status = 'verified'
                   and (v.expires_at is null or v.expires_at > now()))
$$;
revoke all on function public.is_verified_student(uuid) from public, anon, authenticated;

create or replace function public.my_student_verification()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_build_object('status', v.status, 'email', v.email, 'university', u.name, 'verified_at', v.verified_at, 'last_sent_at', v.last_sent_at)
                     from public.student_verifications v left join public.universities u on u.id = v.university_id
                    where v.user_id = auth.uid() and v.status in ('verified', 'pending', 'needs_review')
                    order by case v.status when 'verified' then 0 when 'needs_review' then 1 else 2 end, v.updated_at desc limit 1),
                  jsonb_build_object('status', 'none'))
$$;
revoke all on function public.my_student_verification() from public, anon;
grant execute on function public.my_student_verification() to authenticated;

-- start / resend (server only: the Edge Function made the token and sends the email)
create or replace function public.student_verify_start(p_user uuid, p_email text, p_university uuid, p_campus uuid, p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_dom public.allowed_domains; v_uni uuid; v_row public.student_verifications; v_sent_hour int; v_sent_day int;
  v_profile_email text;
begin
  if p_user is null or not exists (select 1 from public.profiles where id = p_user and role = 'customer') then
    return jsonb_build_object('ok', false, 'error', 'Please sign in.');
  end if;
  if v_email !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' then return jsonb_build_object('ok', false, 'error', 'Please enter a valid email address.'); end if;
  if p_token_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'error', 'Bad request.'); end if;
  if public.is_verified_student(p_user) then return jsonb_build_object('ok', false, 'already', true, 'error', 'You are already a verified student.'); end if;
  if exists (select 1 from public.student_verifications where email = v_email and status in ('verified', 'needs_review') and user_id <> p_user) then
    return jsonb_build_object('ok', false, 'error', 'This university email is already used by another ClickFood account.');
  end if;
  -- the institution's own rules (Supported Institutions list)
  select * into v_dom from public.allowed_domains where domain = public.email_domain_of(v_email) and active;
  if found then
    v_uni := v_dom.university_id;
    if v_dom.student_number_digits is not null and public.student_number_from_email(v_email) is null then
      return jsonb_build_object('ok', false, 'error', 'Use your student-number email address for this university.');
    end if;
    if p_university is not null and v_uni is not null and p_university <> v_uni then
      return jsonb_build_object('ok', false, 'error', 'That email belongs to a different university than the one you chose.');
    end if;
  else
    v_uni := p_university;   -- unknown institution: a developer must approve after the link is opened
  end if;
  if p_campus is not null and not exists (select 1 from public.campuses where id = p_campus and university_id = v_uni) then
    return jsonb_build_object('ok', false, 'error', 'Please choose a campus of that university.');
  end if;
  -- rate limits: 1 a minute, 3 an hour, 10 a day per account
  select count(*) filter (where last_sent_at > now() - interval '1 hour'), sum(send_count) filter (where created_at > now() - interval '1 day')
    into v_sent_hour, v_sent_day from public.student_verifications where user_id = p_user;
  select * into v_row from public.student_verifications where user_id = p_user and status = 'pending' for update;
  if found then
    if v_row.last_sent_at > now() - interval '60 seconds' then
      return jsonb_build_object('ok', false, 'error', 'Please wait a minute before sending another email.', 'retry_after', 60 - extract(epoch from now() - v_row.last_sent_at)::int);
    end if;
    if v_row.send_count >= 3 and v_row.last_sent_at > now() - interval '1 hour' then
      return jsonb_build_object('ok', false, 'error', 'Too many emails. Please try again in an hour.', 'retry_after', 3600);
    end if;
  end if;
  if coalesce(v_sent_day, 0) >= 10 then return jsonb_build_object('ok', false, 'error', 'Too many emails today. Please try again tomorrow.', 'retry_after', 86400); end if;
  if v_row.id is not null then
    update public.student_verifications set email = v_email, university_id = v_uni, campus_id = p_campus, token_hash = p_token_hash,
      token_expires_at = now() + interval '24 hours', confirm_attempts = 0, last_sent_at = now(),
      send_count = case when last_sent_at > now() - interval '1 hour' then send_count + 1 else 1 end, updated_at = now()
     where id = v_row.id;
  else
    insert into public.student_verifications (user_id, email, university_id, campus_id, token_hash, token_expires_at, send_count, last_sent_at)
    values (p_user, v_email, v_uni, p_campus, p_token_hash, now() + interval '24 hours', 1, now());
  end if;
  select email into v_profile_email from public.profiles where id = p_user;
  return jsonb_build_object('ok', true, 'supported', v_dom.id is not null, 'name', (select name from public.profiles where id = p_user));
end $$;

-- the link was opened by the signed-in student
create or replace function public.student_verify_confirm(p_user uuid, p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row public.student_verifications; v_supported boolean;
begin
  if p_user is null or p_token_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'error', 'This link is not valid.'); end if;
  select * into v_row from public.student_verifications where user_id = p_user and status = 'pending' for update;
  if not found then
    if public.is_verified_student(p_user) then return jsonb_build_object('ok', true, 'status', 'verified'); end if;
    return jsonb_build_object('ok', false, 'error', 'We couldn''t verify your student email. Check the address and try again.');
  end if;
  if v_row.confirm_attempts >= 10 then return jsonb_build_object('ok', false, 'error', 'Too many tries. Please send a new email.'); end if;
  if v_row.token_hash is distinct from p_token_hash then
    update public.student_verifications set confirm_attempts = confirm_attempts + 1 where id = v_row.id;
    return jsonb_build_object('ok', false, 'error', 'This link is not valid for your account. Sign in with the account that asked for it.');
  end if;
  if v_row.token_expires_at < now() then return jsonb_build_object('ok', false, 'error', 'This link has expired. Please send a new email.'); end if;
  if exists (select 1 from public.student_verifications where email = v_row.email and status in ('verified', 'needs_review') and user_id <> p_user) then
    return jsonb_build_object('ok', false, 'error', 'This university email is already used by another ClickFood account.');
  end if;
  v_supported := exists (select 1 from public.allowed_domains where domain = public.email_domain_of(v_row.email) and active);
  update public.student_verifications set status = case when v_supported then 'verified' else 'needs_review' end,
    verified_at = case when v_supported then now() end, token_hash = null, token_expires_at = null, updated_at = now()
   where id = v_row.id;
  if v_supported then update public.profiles set is_student = true where id = p_user;
  else
    begin
      perform public.notify_developers('Student email to check: ' || v_row.email || '.', 'student_review', jsonb_build_object('kind', 'student_verification', 'id', v_row.id));
    exception when undefined_function then null; end;
  end if;
  return jsonb_build_object('ok', true, 'status', case when v_supported then 'verified' else 'needs_review' end);
end $$;
revoke all on function public.student_verify_start(uuid, text, uuid, uuid, text), public.student_verify_confirm(uuid, text) from public, anon, authenticated;
grant execute on function public.student_verify_start(uuid, text, uuid, uuid, text), public.student_verify_confirm(uuid, text) to service_role;

-- developer review (approve an unsupported institution, revoke, reject)
create or replace function public.dev_review_student(p_id uuid, p_action text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.student_verifications;
begin
  if public."current_role"() is distinct from 'developer' then return jsonb_build_object('ok', false, 'error', 'Not allowed.'); end if;
  select * into v from public.student_verifications where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Not found.'); end if;
  if p_action = 'approve' and v.status = 'needs_review' then
    update public.student_verifications set status = 'verified', verified_at = now(), reviewed_by = auth.uid(), review_note = left(p_note, 300), updated_at = now() where id = p_id;
    update public.profiles set is_student = true where id = v.user_id;
  elsif p_action = 'reject' and v.status in ('needs_review', 'pending') then
    update public.student_verifications set status = 'rejected', reviewed_by = auth.uid(), review_note = left(p_note, 300), token_hash = null, updated_at = now() where id = p_id;
  elsif p_action = 'revoke' and v.status = 'verified' then
    update public.student_verifications set status = 'revoked', reviewed_by = auth.uid(), review_note = left(p_note, 300), updated_at = now() where id = p_id;
  else
    return jsonb_build_object('ok', false, 'error', 'That change is not possible for this record.');
  end if;
  begin perform public.ops_audit_add(null, 'developer', auth.uid(), 'student_verification_' || p_action, 'saved', jsonb_build_object('verification', p_id)); exception when others then null; end;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.dev_review_student(uuid, text, text) from public, anon;
grant execute on function public.dev_review_student(uuid, text, text) to authenticated;

-- ---------- 4. deals: audience, per-customer limit, university/campus, claims ----------
alter table public.promotions add column if not exists audience text not null default 'everyone';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'promotions_audience_check') then
    alter table public.promotions add constraint promotions_audience_check check (audience in ('everyone', 'students'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'promotions_per_customer_check') then
    alter table public.promotions add column if not exists per_customer_limit int;
    alter table public.promotions add constraint promotions_per_customer_check check (per_customer_limit is null or per_customer_limit between 1 and 1000);
  end if;
end $$;
alter table public.promotions add column if not exists per_customer_limit int;
alter table public.promotions add column if not exists university_id uuid references public.universities(id) on delete set null;
alter table public.promotions add column if not exists campus_id uuid references public.campuses(id) on delete set null;

create table if not exists public.promo_claims (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references public.promotions(id) on delete cascade,
  customer_id uuid not null references public.profiles(id) on delete cascade,
  order_id uuid not null unique references public.orders(id) on delete cascade,
  claimed_at timestamptz not null default now(),
  released_at timestamptz           -- order cancelled: the claim no longer counts
);
create index if not exists promo_claims_customer on public.promo_claims (promotion_id, customer_id) where released_at is null;
alter table public.promo_claims enable row level security;
revoke all on public.promo_claims from anon, authenticated;
grant select on public.promo_claims to authenticated;
drop policy if exists "promo claims read" on public.promo_claims;
create policy "promo claims read" on public.promo_claims for select to authenticated
  using (customer_id = auth.uid() or public."current_role"() = 'developer'
         or exists (select 1 from public.promotions p join public.stores s on s.id = p.store_id where p.id = promotion_id and s.manager_id = auth.uid()));

-- why THIS customer can't use this code now (null = they can). Separate
-- from promo_block_reason (code-level rules) so existing checks stay as they are.
create or replace function public.promo_customer_block_reason(p_code text, p_customer uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare p public.promotions; v_used int; v_prof public.profiles; v_ver public.student_verifications; v_ver_campus uuid; v_ver_uni uuid;
begin
  if p_code is null then return null; end if;
  select * into p from public.promotions where code = upper(btrim(p_code));
  if not found then return null; end if;   -- code-level checks report this
  if p.audience = 'students' then
    select * into v_ver from public.student_verifications where user_id = p_customer and status = 'verified'
      and (expires_at is null or expires_at > now()) order by verified_at desc limit 1;
    if not found then return 'STUDENT_VERIFY: This offer is available to verified students.'; end if;
    v_ver_campus := v_ver.campus_id; v_ver_uni := v_ver.university_id;
    if p.university_id is not null and v_ver_uni is distinct from p.university_id then
      return 'This offer is only for students of ' || coalesce((select name from public.universities where id = p.university_id), 'another university') || '.';
    end if;
  elsif p.university_id is not null then
    select * into v_prof from public.profiles where id = p_customer;
    if v_prof.home_university_id is distinct from p.university_id then
      return 'This offer is only for ' || coalesce((select name from public.universities where id = p.university_id), 'another university') || ' students.';
    end if;
  end if;
  if p.campus_id is not null then
    select * into v_prof from public.profiles where id = p_customer;
    if v_prof.campus_id is distinct from p.campus_id and v_ver_campus is distinct from p.campus_id then
      return 'This offer is only for ' || coalesce((select full_name from public.campuses where id = p.campus_id), 'another campus') || '.';
    end if;
  end if;
  if p.per_customer_limit is not null then
    select count(*) into v_used from public.promo_claims where promotion_id = p.id and customer_id = p_customer and released_at is null;
    if v_used >= p.per_customer_limit then
      return case when p.per_customer_limit = 1 then 'You have already used this offer.' else 'You have used this offer the maximum number of times.' end;
    end if;
  end if;
  return null;
end $$;
revoke all on function public.promo_customer_block_reason(text, uuid) from public, anon, authenticated;

-- the app asks before checkout (same rules the order is checked against)
create or replace function public.check_my_promo(p_code text, p_subtotal numeric default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r text; c text;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'Please sign in to use this code.'); end if;
  c := public.promo_block_reason(p_code, p_subtotal);
  if c is not null then return jsonb_build_object('ok', false, 'error', c); end if;
  r := public.promo_customer_block_reason(p_code, auth.uid());
  if r is null then return jsonb_build_object('ok', true); end if;
  if r like 'STUDENT_VERIFY:%' then return jsonb_build_object('ok', false, 'needs_student', true, 'error', btrim(substr(r, 16))); end if;
  return jsonb_build_object('ok', false, 'error', r);
end $$;
revoke all on function public.check_my_promo(text, numeric) from public, anon;
grant execute on function public.check_my_promo(text, numeric) to authenticated;

-- order saved with a code: one customer at a time per deal (lock), checked,
-- then the claim is recorded after the order exists
create or replace function public.promo_claim_check()
returns trigger language plpgsql security definer set search_path = public as $$
declare r text;
begin
  if new.promo_code is null or new.customer_id is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('promo:' || upper(btrim(new.promo_code)) || ':' || new.customer_id::text, 0));
  r := public.promo_customer_block_reason(new.promo_code, new.customer_id);
  if r is not null then
    if auth.uid() is not null then
      raise exception '%', case when r like 'STUDENT_VERIFY:%' then btrim(substr(r, 16)) else r end using errcode = 'P0001';
    end if;
    -- a paid card order (saved by the server) is never refused here; the
    -- payment step checked the same rules before taking the money
  end if;
  return new;
end $$;
drop trigger if exists trg_c0_promo_claim_check on public.orders;
create trigger trg_c0_promo_claim_check before insert on public.orders
  for each row execute function public.promo_claim_check();

create or replace function public.promo_claim_record()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_promo uuid;
begin
  if tg_op = 'INSERT' then
    if new.promo_code is null or new.customer_id is null or new.status = 'cancelled' then return null; end if;
    select id into v_promo from public.promotions where code = new.promo_code;
    if v_promo is not null then
      insert into public.promo_claims (promotion_id, customer_id, order_id) values (v_promo, new.customer_id, new.id) on conflict (order_id) do nothing;
    end if;
  elsif new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    update public.promo_claims set released_at = now() where order_id = new.id and released_at is null;
  end if;
  return null;
end $$;
drop trigger if exists trg_promo_claim_record on public.orders;
create trigger trg_promo_claim_record after insert or update of status on public.orders
  for each row execute function public.promo_claim_record();

-- the payment step (create-payfast-payment, service role) checks the same rules
create or replace function public.promo_customer_check(p_code text, p_customer uuid)
returns text language sql stable security definer set search_path = public as $$
  select case when r like 'STUDENT_VERIFY:%' then btrim(substr(r, 16)) else r end from (select public.promo_customer_block_reason(p_code, p_customer) r) x
$$;
revoke all on function public.promo_customer_check(text, uuid) from public, anon, authenticated;
grant execute on function public.promo_customer_check(text, uuid) to service_role;
revoke all on function public.promo_claim_check(), public.promo_claim_record() from public, anon, authenticated;

-- ---------- 5. student sellers: a verified student email counts too ----------
-- (built from the live become_student_seller; only the student check and the
-- university source changed)
CREATE OR REPLACE FUNCTION public.become_student_seller(p_business_name text, p_whatsapp text, p_categories text[], p_other_food text, p_campus text, p_description text, p_logo_url text, p_cover_url text, p_address text, p_lat double precision, p_lng double precision, p_hustleup boolean, p_accept_rules boolean, p_details jsonb)
 RETURNS stores
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uni text;   -- the student's university: from a student login email, else from a verified student email
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
  if not public.is_up_student_email(v_user.email) and not public.is_verified_student(v_uid) then
    raise exception 'Verify your student email first (Profile, Student status), then open your shop.';
  end if;
  if v_user.email_confirmed_at is null then raise exception 'Please verify your email address first.'; end if;
  v_uni := coalesce(public.university_of_email(v_user.email),
    (select u.name from public.student_verifications sv join public.universities u on u.id = sv.university_id
      where sv.user_id = v_uid and sv.status = 'verified' order by sv.verified_at desc limit 1));
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
  if v_campus is null or (cardinality(public.university_campuses(v_uni)) > 0
                          and not (v_campus = any (public.university_campuses(v_uni)))) then
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
          p_lat, p_lng, coalesce(v_uni, 'University of Pretoria'), 'student', 'pending', false, 0,
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
