-- ============================================================
-- CLICKFOOD, ONE Student Entrepreneur application + shop setup drafts
-- (2026-10-18). Needs student_entrepreneurs.sql and institutions_v2.sql.
--
-- 1. Exactly one eligibility application per student (unique user_id).
--    Saving after a rejection or a withdrawal reopens THAT record as a
--    draft; submitting changes its status; approval updates it. Shop and
--    menu records stay separate (stores / menu_items, their own reviews).
-- 2. shop_setup_drafts: the approved student's unfinished shop setup,
--    saved in the database (not the browser) so it survives a refresh, a
--    sign-out or another device. Only the owner reads it; it is written only
--    through save_shop_setup_draft() (approved applicants without a shop)
--    and removed once the shop is created.
-- Safe to run more than once. Rollback: entrepreneur_single_application_rollback.sql
-- ============================================================

-- ---------- 1. one application per student ----------
do $$ begin
  if not exists (select 1 from public.entrepreneur_applications group by user_id having count(*) > 1) then
    create unique index if not exists entrepreneur_applications_one_per_user on public.entrepreneur_applications (user_id);
  else
    raise notice 'Some students have more than one application: unique index not created (reconcile first).';
  end if;
end $$;

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
  if not exists (select 1 from public.profiles where id = v_uid and coalesce(is_student, false)) then
    return jsonb_build_object('ok', false, 'error', 'The Student Entrepreneur Programme is for student accounts.');
  end if;
  if exists (select 1 from public.stores where manager_id = v_uid and seller_kind = 'student' and archived_by is distinct from manager_id) then
    return jsonb_build_object('ok', false, 'error', 'You already have a student shop.');
  end if;
  select * into a from public.entrepreneur_applications where user_id = v_uid and status in ('draft', 'pending_review', 'under_review', 'approved') for update;
  -- one application per student: after a rejection (or a withdrawal) the SAME record is reopened as a draft
  if a.id is null then
    select * into a from public.entrepreneur_applications where user_id = v_uid and status in ('rejected', 'withdrawn') order by updated_at desc limit 1 for update;
    if a.id is not null then
      update public.entrepreneur_applications set status = 'draft', updated_at = now() where id = a.id returning * into a;
    end if;
  end if;
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

-- ---------- 2. shop setup drafts ----------
create table if not exists public.shop_setup_drafts (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) < 20000),
  updated_at timestamptz not null default now()
);
alter table public.shop_setup_drafts enable row level security;
revoke all on public.shop_setup_drafts from anon, authenticated;
grant select on public.shop_setup_drafts to authenticated;
drop policy if exists "shop setup drafts own" on public.shop_setup_drafts;
create policy "shop setup drafts own" on public.shop_setup_drafts for select to authenticated using (user_id = auth.uid());

create or replace function public.save_shop_setup_draft(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); k text; v jsonb := '{}'::jsonb;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'Please sign in.'); end if;
  if not exists (select 1 from public.entrepreneur_applications where user_id = v_uid and status = 'approved' and store_id is null) then
    return jsonb_build_object('ok', false, 'error', 'Your Student Entrepreneur application must be approved first.');
  end if;
  if exists (select 1 from public.stores where manager_id = v_uid and seller_kind = 'student' and archived_by is distinct from manager_id) then
    return jsonb_build_object('ok', false, 'error', 'You already have a shop.');
  end if;
  -- only the shop setup answers (nothing that grants anything)
  foreach k in array array['business_name', 'whatsapp', 'campus', 'address', 'pin', 'cover', 'logo', 'hustleup', 'details'] loop
    if p ? k then v := v || jsonb_build_object(k, p->k); end if;
  end loop;
  insert into public.shop_setup_drafts (user_id, data, updated_at) values (v_uid, v, now())
  on conflict (user_id) do update set data = excluded.data, updated_at = now();
  return jsonb_build_object('ok', true, 'saved_at', now());
exception when check_violation then
  return jsonb_build_object('ok', false, 'error', 'The draft is too large to save.');
end $$;
revoke all on function public.save_shop_setup_draft(jsonb) from public, anon;
grant execute on function public.save_shop_setup_draft(jsonb) to authenticated;

-- the shop is created: link it to the application and drop the draft
create or replace function public.link_entrepreneur_shop()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.seller_kind = 'student' then
    update public.entrepreneur_applications set store_id = new.id, updated_at = now()
     where user_id = new.manager_id and status = 'approved' and store_id is null;
    delete from public.shop_setup_drafts where user_id = new.manager_id;
  end if;
  return null;
end $$;
revoke all on function public.link_entrepreneur_shop() from public, anon, authenticated;
