-- ============================================================
-- CLICKFOOD, Student Entrepreneur Programme (2026-10-17)
-- Needs open_signup_students.sql and privacy_legal.sql first.
--
-- A customer applies to sell food as a student. Steps:
--   1. a verified UNIVERSITY STUDENT email of a programme institution
--      (allowed_domains.entrepreneur_eligible; starts with UP tuks.co.za):
--      their login email (confirmed) or a student_verifications email
--      proved by the emailed link (student-verify). A matching domain alone
--      is never enough.
--   2. the application (draft -> pending_review), saved only through
--      save_entrepreneur_application(), checked here.
--   3. a developer reviews: under_review -> approved | rejected (reason,
--      optionally shown to the applicant). Applicants can withdraw.
--   4. only an APPROVED applicant can create a student shop (trigger on
--      stores); the shop then goes through the existing shop review.
-- Population group is optional, kept in a separate table only developers
-- can read, never used in decisions, and deleted 90 days after a decision.
-- Existing student shops are untouched. Safe to run more than once.
-- Rollback: student_entrepreneurs_rollback.sql
-- ============================================================

-- ---------- 1. which institutions take part ----------
alter table public.allowed_domains add column if not exists entrepreneur_eligible boolean not null default false;
update public.allowed_domains set entrepreneur_eligible = true where domain = 'tuks.co.za' and not entrepreneur_eligible;

-- the verified programme student email of a user (null = none)
create or replace function public.entrepreneur_email(p_user uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare v_email text; v_conf timestamptz; d public.allowed_domains;
begin
  select lower(email), email_confirmed_at into v_email, v_conf from auth.users where id = p_user;
  if v_email is not null and v_conf is not null then
    select * into d from public.allowed_domains where domain = public.email_domain_of(v_email) and entrepreneur_eligible;
    if found and (d.student_number_digits is null or public.student_number_from_email(v_email) is not null) then return v_email; end if;
  end if;
  select sv.email into v_email from public.student_verifications sv
    join public.allowed_domains ad on ad.domain = public.email_domain_of(sv.email) and ad.entrepreneur_eligible
   where sv.user_id = p_user and sv.status = 'verified' and (sv.expires_at is null or sv.expires_at > now())
   order by sv.verified_at desc limit 1;
  return v_email;
end $$;
revoke all on function public.entrepreneur_email(uuid) from public, anon, authenticated;

-- ---------- 2. applications ----------
create table if not exists public.entrepreneur_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'pending_review', 'under_review', 'approved', 'rejected', 'withdrawn')),
  full_name text check (full_name is null or length(full_name) between 2 and 80),
  student_email text,                 -- copied by the server from the verified source at submission
  phone text,                          -- 27XXXXXXXXX
  university text not null default 'University of Pretoria',
  year_of_study text check (year_of_study is null or year_of_study in ('first', 'second', 'third', 'fourth', 'fifth', 'sixth_plus', 'other')),
  expected_stay text check (expected_stay is null or expected_stay in ('lt1', '1', '2', '3', '4', '5plus', 'unsure')),
  years_left text check (years_left is null or years_left in ('lt1', '1', '2', '3', '4', '5plus', 'unsure')),
  business_name text check (business_name is null or length(business_name) between 2 and 60),
  categories text[] not null default '{}' check (categories <@ array['breakfast', 'lunch', 'dinner', 'snacks', 'baked', 'drinks', 'other']::text[]),
  other_category text check (other_category is null or length(other_category) <= 120),
  description text check (description is null or length(description) <= 1000),
  why_choose text check (why_choose is null or length(why_choose) <= 1000),
  food_safety text check (food_safety is null or length(food_safety) <= 800),
  available_days int[] not null default '{}' check (available_days <@ array[0, 1, 2, 3, 4, 5, 6]),
  available_periods text[] not null default '{}' check (available_periods <@ array['morning', 'midday', 'afternoon', 'evening']::text[]),
  info_confirmed_at timestamptz,
  terms_version text, terms_accepted_at timestamptz,
  privacy_version text, privacy_acknowledged_at timestamptz,
  submitted_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  decision_reason text check (decision_reason is null or length(decision_reason) <= 500),
  reason_visible boolean not null default false,
  store_id uuid references public.stores(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- one open application per student
create unique index if not exists entrepreneur_applications_one_active on public.entrepreneur_applications (user_id)
  where status in ('draft', 'pending_review', 'under_review', 'approved');
create index if not exists entrepreneur_applications_status on public.entrepreneur_applications (status, submitted_at);
alter table public.entrepreneur_applications enable row level security;
revoke all on public.entrepreneur_applications from anon, authenticated;
grant select on public.entrepreneur_applications to authenticated;
drop policy if exists "entrepreneur applications read" on public.entrepreneur_applications;
create policy "entrepreneur applications read" on public.entrepreneur_applications for select to authenticated
  using (user_id = auth.uid() or public."current_role"() = 'developer');
-- no insert/update/delete policies: every write goes through the functions below

-- optional population group: developers only
create table if not exists public.entrepreneur_demographics (
  application_id uuid primary key references public.entrepreneur_applications(id) on delete cascade,
  population_group text not null check (population_group in ('black_african', 'coloured', 'indian_asian', 'white', 'other')),
  consented_at timestamptz not null default now()
);
alter table public.entrepreneur_demographics enable row level security;
revoke all on public.entrepreneur_demographics from anon, authenticated;
grant select on public.entrepreneur_demographics to authenticated;
drop policy if exists "entrepreneur demographics developer" on public.entrepreneur_demographics;
create policy "entrepreneur demographics developer" on public.entrepreneur_demographics for select to authenticated
  using (public."current_role"() = 'developer');

-- ---------- 3. what the app shows the student ----------
create or replace function public.my_entrepreneur_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); a public.entrepreneur_applications; v_pg text; v_shop uuid;
begin
  if v_uid is null then return jsonb_build_object('signed_in', false); end if;
  select id into v_shop from public.stores where manager_id = v_uid and seller_kind = 'student' and archived_by is distinct from manager_id limit 1;
  select * into a from public.entrepreneur_applications where user_id = v_uid
   order by case when status in ('draft', 'pending_review', 'under_review', 'approved') then 0 else 1 end, updated_at desc limit 1;
  if a.id is not null then select population_group into v_pg from public.entrepreneur_demographics where application_id = a.id; end if;
  return jsonb_build_object(
    'signed_in', true,
    'has_shop', v_shop is not null,
    'eligible_email', public.entrepreneur_email(v_uid),
    'programme_domains', (select coalesce(jsonb_agg(jsonb_build_object('domain', domain, 'institution', institution_name, 'digits', student_number_digits, 'prefix', student_number_prefix) order by institution_name), '[]'::jsonb)
                            from public.allowed_domains where entrepreneur_eligible and active),
    'versions', public.legal_versions(),
    'application', case when a.id is null then null else
      (to_jsonb(a) - 'reviewed_by' - 'decision_reason' - 'reason_visible')
      || jsonb_build_object('decision_reason', case when a.reason_visible then a.decision_reason end, 'population_group', v_pg) end);
end $$;
revoke all on function public.my_entrepreneur_status() from public, anon;
grant execute on function public.my_entrepreneur_status() to authenticated;

-- ---------- 4. save a draft / submit ----------
create or replace function public.save_entrepreneur_application(p jsonb, p_submit boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); a public.entrepreneur_applications; v_email text; v_phone text; v_err text;
  v_cats text[]; v_days int[]; v_periods text[]; v_pg text := nullif(btrim(coalesce(p->>'population_group', '')), '');
  t text;
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid and role = 'customer' and coalesce(active, true)) then
    return jsonb_build_object('ok', false, 'error', 'Please sign in with your ClickFood account.');
  end if;
  if exists (select 1 from public.stores where manager_id = v_uid and seller_kind = 'student' and archived_by is distinct from manager_id) then
    return jsonb_build_object('ok', false, 'error', 'You already have a student shop.');
  end if;
  select * into a from public.entrepreneur_applications where user_id = v_uid and status in ('draft', 'pending_review', 'under_review', 'approved') for update;
  if a.id is not null and a.status <> 'draft' then
    return jsonb_build_object('ok', false, 'error', 'Your application has already been submitted.');
  end if;
  begin
    select coalesce(array_agg(distinct x), '{}') into v_cats from jsonb_array_elements_text(coalesce(p->'categories', '[]')) x;
    select coalesce(array_agg(distinct x::int), '{}') into v_days from jsonb_array_elements_text(coalesce(p->'available_days', '[]')) x;
    select coalesce(array_agg(distinct x), '{}') into v_periods from jsonb_array_elements_text(coalesce(p->'available_periods', '[]')) x;
  exception when others then return jsonb_build_object('ok', false, 'error', 'Please check your answers.'); end;
  if not (v_cats <@ array['breakfast', 'lunch', 'dinner', 'snacks', 'baked', 'drinks', 'other']::text[]) or not (v_days <@ array[0, 1, 2, 3, 4, 5, 6])
     or not (v_periods <@ array['morning', 'midday', 'afternoon', 'evening']::text[]) then
    return jsonb_build_object('ok', false, 'error', 'Please check your answers.');
  end if;
  if v_pg is not null and v_pg not in ('black_african', 'coloured', 'indian_asian', 'white', 'other', 'prefer_not') then
    return jsonb_build_object('ok', false, 'error', 'Please check your answers.');
  end if;
  v_phone := public.normalize_sa_whatsapp(p->>'phone');
  -- fields (trimmed, length-limited; full checks only when submitting)
  if a.id is null then
    insert into public.entrepreneur_applications (user_id) values (v_uid) returning * into a;
  end if;
  begin
    update public.entrepreneur_applications set
      full_name = nullif(btrim(left(coalesce(p->>'full_name', ''), 80)), ''),
      phone = coalesce(v_phone, nullif(btrim(left(coalesce(p->>'phone', ''), 20)), '')),
      year_of_study = nullif(p->>'year_of_study', ''), expected_stay = nullif(p->>'expected_stay', ''), years_left = nullif(p->>'years_left', ''),
      business_name = nullif(btrim(left(coalesce(p->>'business_name', ''), 60)), ''),
      categories = v_cats,
      other_category = case when 'other' = any (v_cats) then nullif(btrim(left(coalesce(p->>'other_category', ''), 120)), '') end,
      description = nullif(btrim(left(coalesce(p->>'description', ''), 1000)), ''),
      why_choose = nullif(btrim(left(coalesce(p->>'why_choose', ''), 1000)), ''),
      food_safety = nullif(btrim(left(coalesce(p->>'food_safety', ''), 800)), ''),
      available_days = v_days, available_periods = v_periods, updated_at = now()
     where id = a.id returning * into a;
  exception when check_violation then return jsonb_build_object('ok', false, 'error', 'Please check your answers.'); end;
  -- optional population group: only with its own consent; "prefer not" / empty removes it
  if v_pg is null or v_pg = 'prefer_not' or not coalesce((p->>'population_group_consent')::boolean, false) then
    delete from public.entrepreneur_demographics where application_id = a.id;
  else
    insert into public.entrepreneur_demographics (application_id, population_group) values (a.id, v_pg)
      on conflict (application_id) do update set population_group = excluded.population_group, consented_at = now();
  end if;
  if not coalesce(p_submit, false) then return jsonb_build_object('ok', true, 'status', 'draft', 'id', a.id); end if;

  -- ---- submitting: everything required, checked here ----
  v_email := public.entrepreneur_email(v_uid);
  if v_email is null then
    return jsonb_build_object('ok', false, 'needs_email', true, 'error', 'An official university student email is required. Verify your student email first.');
  end if;
  v_err := case
    when a.full_name is null then 'Please enter your full name.'
    when v_phone is null then 'Please enter a valid South African phone number.'
    when a.year_of_study is null then 'Please choose your year of study.'
    when a.expected_stay is null then 'Please say how long you expect to remain at university.'
    when a.years_left is null then 'Please say how many years you have left.'
    when a.business_name is null then 'Please enter your food business name.'
    when cardinality(a.categories) = 0 then 'Please choose what you will be selling.'
    when 'other' = any (a.categories) and a.other_category is null then 'Please say what "Other" food you will sell.'
    when length(coalesce(a.description, '')) < 30 then 'Please describe your food business (at least 30 characters).'
    when length(coalesce(a.why_choose, '')) < 30 then 'Please say why your business is a good choice (at least 30 characters).'
    when length(coalesce(a.food_safety, '')) < 20 then 'Please explain how you will prepare, store and supply your food safely (at least 20 characters).'
    when cardinality(a.available_days) = 0 then 'Please choose the days you expect to sell.'
    when not coalesce((p->>'confirm_accurate')::boolean, false) then 'Please confirm that your information is accurate.'
    when not coalesce((p->>'accept_terms')::boolean, false) then 'Please accept the Terms of Service.'
    when not coalesce((p->>'ack_privacy')::boolean, false) then 'Please confirm that you have read the Privacy Policy.'
  end;
  if v_err is null then
    t := coalesce(public.non_food_word(a.business_name), public.alcohol_word(a.business_name), public.non_food_word(a.other_category));
    if t is not null then v_err := 'ClickFood is for food sellers only.'; end if;
  end if;
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err, 'id', a.id); end if;
  update public.entrepreneur_applications set status = 'pending_review', student_email = v_email, phone = v_phone,
    university = coalesce((select institution_name from public.allowed_domains where domain = public.email_domain_of(v_email)), university),
    info_confirmed_at = now(), terms_version = public.legal_versions()->>'terms', terms_accepted_at = now(),
    privacy_version = public.legal_versions()->>'privacy', privacy_acknowledged_at = now(), submitted_at = now(), updated_at = now()
   where id = a.id;
  begin
    perform public.notify_developers('New Student Entrepreneur application: ' || a.business_name || '.', 'entrepreneur_review',
      jsonb_build_object('kind', 'entrepreneur_application', 'id', a.id));
  exception when undefined_function then null; end;
  return jsonb_build_object('ok', true, 'status', 'pending_review', 'id', a.id);
end $$;
revoke all on function public.save_entrepreneur_application(jsonb, boolean) from public, anon;
grant execute on function public.save_entrepreneur_application(jsonb, boolean) to authenticated;

create or replace function public.withdraw_entrepreneur_application()
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.entrepreneur_applications;
begin
  select * into a from public.entrepreneur_applications where user_id = auth.uid() and status in ('draft', 'pending_review', 'under_review') for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'There is no open application to withdraw.'); end if;
  update public.entrepreneur_applications set status = 'withdrawn', reviewed_at = case when status = 'draft' then reviewed_at else now() end, updated_at = now() where id = a.id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.withdraw_entrepreneur_application() from public, anon;
grant execute on function public.withdraw_entrepreneur_application() to authenticated;

-- ---------- 5. developer review ----------
create or replace function public.dev_review_entrepreneur(p_id uuid, p_action text, p_reason text default null, p_share boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.entrepreneur_applications; v_reason text := nullif(btrim(left(coalesce(p_reason, ''), 500)), '');
begin
  if public."current_role"() is distinct from 'developer' then return jsonb_build_object('ok', false, 'error', 'Not allowed.'); end if;
  select * into a from public.entrepreneur_applications where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Application not found.'); end if;
  if p_action = 'start' and a.status = 'pending_review' then
    update public.entrepreneur_applications set status = 'under_review', reviewed_by = auth.uid(), updated_at = now() where id = p_id;
  elsif p_action = 'approve' and a.status in ('pending_review', 'under_review') then
    update public.entrepreneur_applications set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), decision_reason = v_reason,
      reason_visible = coalesce(p_share, false) and v_reason is not null, updated_at = now() where id = p_id;
    insert into public.notifications (user_id, message, type) values (a.user_id,
      'Your Student Entrepreneur application for ' || a.business_name || ' was approved. Set up your shop now.', 'entrepreneur_decision');
  elsif p_action = 'reject' and a.status in ('pending_review', 'under_review') then
    if v_reason is null then return jsonb_build_object('ok', false, 'error', 'Please record a reason.'); end if;
    update public.entrepreneur_applications set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), decision_reason = v_reason,
      reason_visible = coalesce(p_share, false), updated_at = now() where id = p_id;
    insert into public.notifications (user_id, message, type) values (a.user_id,
      'Your Student Entrepreneur application for ' || a.business_name || ' was not approved.', 'entrepreneur_decision');
  else
    return jsonb_build_object('ok', false, 'error', 'That change is not possible for this application.');
  end if;
  begin perform public.ops_audit_add(null, 'developer', auth.uid(), 'entrepreneur_' || p_action, 'saved', jsonb_build_object('application', p_id)); exception when others then null; end;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.dev_review_entrepreneur(uuid, text, text, boolean) from public, anon;
grant execute on function public.dev_review_entrepreneur(uuid, text, text, boolean) to authenticated;

-- ---------- 6. only approved applicants get a student shop ----------
create or replace function public.require_approved_entrepreneur()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.seller_kind = 'student' then
    if not exists (select 1 from public.entrepreneur_applications where user_id = new.manager_id and status = 'approved' and store_id is null) then
      raise exception 'Your Student Entrepreneur application must be approved before you can open a shop.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_a1_require_approved_entrepreneur on public.stores;
create trigger trg_a1_require_approved_entrepreneur before insert on public.stores
  for each row execute function public.require_approved_entrepreneur();

create or replace function public.link_entrepreneur_shop()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.seller_kind = 'student' then
    update public.entrepreneur_applications set store_id = new.id, updated_at = now()
     where user_id = new.manager_id and status = 'approved' and store_id is null;
  end if;
  return null;
end $$;
drop trigger if exists trg_link_entrepreneur_shop on public.stores;
create trigger trg_link_entrepreneur_shop after insert on public.stores
  for each row execute function public.link_entrepreneur_shop();
revoke all on function public.require_approved_entrepreneur(), public.link_entrepreneur_shop() from public, anon, authenticated;

-- ---------- 7. retention ----------
-- population group: removed 90 days after a decision (or withdrawal)
create or replace function public.purge_entrepreneur_sensitive()
returns void language sql security definer set search_path = public as $$
  delete from public.entrepreneur_demographics d using public.entrepreneur_applications a
   where a.id = d.application_id and a.status in ('approved', 'rejected', 'withdrawn')
     and coalesce(a.reviewed_at, a.updated_at) < now() - interval '90 days';
$$;
revoke all on function public.purge_entrepreneur_sensitive() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'purge-entrepreneur-sensitive';
    perform cron.schedule('purge-entrepreneur-sensitive', '41 3 * * *', 'select public.purge_entrepreneur_sensitive()');
  end if;
end $$;

-- deleting an account also removes its applications (privacy_legal.sql + this)
create or replace function public.scrub_deleted_customer()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role = 'deleted' and old.role is distinct from 'deleted' then
    update public.orders
       set delivery_location = coalesce(delivery_location, '{}'::jsonb) - 'phone' - 'customerName' - 'studentNumber' - 'room' - 'building' - 'instructions',
           cancel_note = null
     where customer_id = new.id;
    delete from public.student_verifications where user_id = new.id;
    delete from public.entrepreneur_applications where user_id = new.id;
  end if;
  return null;
end $$;

-- ---------- 8. Terms / Privacy now include the programme ----------
alter table public.legal_acceptances drop constraint if exists legal_acceptances_version_check;
alter table public.legal_acceptances add constraint legal_acceptances_version_check check (version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]+)?$');
create or replace function public.legal_versions()
returns jsonb language sql immutable as $$ select '{"terms": "2026-10-17.2", "privacy": "2026-10-17.2"}'::jsonb $$;
grant execute on function public.legal_versions() to anon, authenticated;
