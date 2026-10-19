-- ============================================================
-- CLICKFOOD, multi-university shop discovery (2026-10-16)
--
-- universities          one row per university/college, stable id. Kept in
--                       step with the developer's Supported Institutions list
--                       (allowed_domains): adding an institution there adds
--                       the university here, no code change needed.
-- profiles.home_university_id
--                       the student's "home university": shops there come
--                       first. Filled from the student email at sign-up
--                       (profiles.university stays locked to the email, as
--                       proof of institution); the student may change the home
--                       university in Profile. It is a browsing preference
--                       only and never grants any access.
-- stores.availability   'university' (belongs to its university/ies) or
--                       'everyone' (explicitly for all ClickFood students,
--                       e.g. off-campus businesses). Only a developer sets it.
-- store_universities    which universities a shop serves (one or more).
--                       Only a developer changes it.
-- discover_shops()      ONE place that decides each student's sections:
--                       mine -> everyone -> other universities.
--
-- Additive only: no data is removed, existing columns stay as they are.
-- Safe to run more than once.
-- ============================================================

-- ---------- universities ----------
create table if not exists public.universities (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(btrim(name)) between 2 and 120),
  short_code text not null unique check (short_code ~ '^[A-Z0-9]{1,12}$'),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.universities enable row level security;
drop policy if exists "universities read" on public.universities;
create policy "universities read" on public.universities for select to anon, authenticated using (true);
revoke all on public.universities from anon, authenticated;
grant select on public.universities to anon, authenticated;

create or replace function public.university_short_code(p_name text)
returns text language plpgsql immutable as $$
declare v text; w text;
begin
  v := case lower(btrim(p_name))
         when 'university of pretoria' then 'UP'
         when 'tshwane university of technology' then 'TUT'
         when 'university of south africa' then 'UNISA'
         when 'eduvos' then 'EDUVOS'
         when 'rosebank college' then 'RC'
         when 'university of johannesburg' then 'UJ'
         when 'university of the witwatersrand' then 'WITS'
         else null end;
  if v is not null then return v; end if;
  v := '';
  foreach w in array regexp_split_to_array(btrim(p_name), '\s+') loop
    if lower(w) not in ('of', 'the', 'and', 'for') and w ~ '^[A-Za-z]' then v := v || upper(left(w, 1)); end if;
  end loop;
  return left(coalesce(nullif(v, ''), 'U'), 12);
end $$;

-- get (or create) a university by name; short codes made unique if needed
create or replace function public.ensure_university(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_code text; v_try text; n int := 1;
begin
  if p_name is null or length(btrim(p_name)) < 2 then return null; end if;
  select id into v_id from public.universities where lower(name) = lower(btrim(p_name));
  if v_id is not null then return v_id; end if;
  v_code := public.university_short_code(p_name); v_try := v_code;
  while exists (select 1 from public.universities where short_code = v_try) loop
    n := n + 1; v_try := left(v_code, 10) || n;
  end loop;
  insert into public.universities (name, short_code) values (btrim(p_name), v_try)
    on conflict (name) do nothing returning id into v_id;
  if v_id is null then select id into v_id from public.universities where lower(name) = lower(btrim(p_name)); end if;
  return v_id;
end $$;

-- every institution on the Supported Institutions list, every university a
-- shop or a profile already names
select public.ensure_university(x) from (
  select institution_name x from public.allowed_domains
  union select university from public.stores where university is not null
  union select university from public.profiles where university is not null) s;

alter table public.allowed_domains add column if not exists university_id uuid references public.universities(id);
update public.allowed_domains d set university_id = public.ensure_university(d.institution_name) where university_id is null;
create or replace function public.allowed_domain_university()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.university_id := public.ensure_university(new.institution_name);
  return new;
end $$;
drop trigger if exists trg_allowed_domain_university on public.allowed_domains;
create trigger trg_allowed_domain_university before insert or update of institution_name on public.allowed_domains
  for each row execute function public.allowed_domain_university();

-- ---------- the student's home university ----------
alter table public.profiles add column if not exists home_university_id uuid references public.universities(id) on delete set null;
create index if not exists profiles_home_university on public.profiles (home_university_id);
update public.profiles p set home_university_id = u.id
  from public.universities u
 where p.home_university_id is null and p.role = 'customer' and p.university is not null and lower(u.name) = lower(p.university);

-- filled from the (email-locked) university when missing; a change must name
-- an ACTIVE university. Runs after trg_lock_student_university (name order).
create or replace function public.set_home_university()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.home_university_id is null and new.role = 'customer' and new.university is not null then
    new.home_university_id := public.ensure_university(new.university);
  end if;
  if new.home_university_id is distinct from (case when tg_op = 'UPDATE' then old.home_university_id end)
     and new.home_university_id is not null
     and not exists (select 1 from public.universities where id = new.home_university_id and active) then
    raise exception 'Please choose a university from the list.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_set_home_university on public.profiles;
create trigger trg_set_home_university before insert or update of home_university_id, university, role on public.profiles
  for each row execute function public.set_home_university();

-- the student's own change (Profile); same rules as the trigger
create or replace function public.set_my_home_university(p_university uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_name text;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'Please sign in.'); end if;
  if not exists (select 1 from public.profiles where id = v_uid and role = 'customer') then
    return jsonb_build_object('ok', false, 'error', 'Only students choose a home university.');
  end if;
  select name into v_name from public.universities where id = p_university and active;
  if v_name is null then return jsonb_build_object('ok', false, 'error', 'Please choose a university from the list.'); end if;
  update public.profiles set home_university_id = p_university where id = v_uid;
  return jsonb_build_object('ok', true, 'university_id', p_university, 'university', v_name);
end $$;
revoke all on function public.set_my_home_university(uuid) from public, anon;
grant execute on function public.set_my_home_university(uuid) to authenticated;

-- ---------- shops: availability + universities served ----------
alter table public.stores add column if not exists availability text not null default 'university';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'stores_availability_check') then
    alter table public.stores add constraint stores_availability_check check (availability in ('university', 'everyone'));
  end if;
end $$;

create table if not exists public.store_universities (
  store_id uuid not null references public.stores(id) on delete cascade,
  university_id uuid not null references public.universities(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (store_id, university_id)
);
create index if not exists store_universities_university on public.store_universities (university_id);
create index if not exists stores_discovery on public.stores (status, is_published);
alter table public.store_universities enable row level security;
drop policy if exists "store universities read" on public.store_universities;
-- readable for shops the reader can already see (stores RLS decides)
create policy "store universities read" on public.store_universities for select to anon, authenticated
  using (exists (select 1 from public.stores s where s.id = store_id));
revoke all on public.store_universities from anon, authenticated;
grant select on public.store_universities to anon, authenticated;

-- a shop always serves the university it was registered at
insert into public.store_universities (store_id, university_id)
select s.id, public.ensure_university(s.university) from public.stores s where s.university is not null
on conflict do nothing;
create or replace function public.store_home_university()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.university is not null and (tg_op = 'INSERT' or new.university is distinct from old.university) then
    insert into public.store_universities (store_id, university_id) values (new.id, public.ensure_university(new.university))
      on conflict do nothing;
  end if;
  return null;
end $$;
drop trigger if exists trg_store_home_university on public.stores;
create trigger trg_store_home_university after insert or update of university on public.stores
  for each row execute function public.store_home_university();

-- only a developer changes availability (managers can't make their shop
-- "for everyone"); requests without a signed-in user (migrations) pass
create or replace function public.protect_store_availability()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.availability is distinct from old.availability
     and coalesce(current_setting('request.jwt.claims', true), '') <> ''
     and public."current_role"() is distinct from 'developer' then
    new.availability := old.availability;
  end if;
  return new;
end $$;
drop trigger if exists trg_protect_store_availability on public.stores;
create trigger trg_protect_store_availability before update on public.stores
  for each row execute function public.protect_store_availability();

-- developer: set a shop's availability and universities in one go
create or replace function public.set_store_universities(p_store uuid, p_availability text, p_universities uuid[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_n int;
begin
  if v_uid is null or public."current_role"() is distinct from 'developer' then
    return jsonb_build_object('ok', false, 'error', 'Not allowed.');
  end if;
  if p_availability not in ('university', 'everyone') then return jsonb_build_object('ok', false, 'error', 'Bad request.'); end if;
  if not exists (select 1 from public.stores where id = p_store) then return jsonb_build_object('ok', false, 'error', 'Shop not found.'); end if;
  select count(*) into v_n from unnest(coalesce(p_universities, '{}')) x where exists (select 1 from public.universities u where u.id = x);
  if v_n <> coalesce(array_length(p_universities, 1), 0) then return jsonb_build_object('ok', false, 'error', 'Unknown university.'); end if;
  if p_availability = 'university' and v_n = 0 then
    return jsonb_build_object('ok', false, 'error', 'Choose at least one university, or make the shop available to everyone.');
  end if;
  update public.stores set availability = p_availability where id = p_store;
  delete from public.store_universities where store_id = p_store and not (university_id = any (coalesce(p_universities, '{}')));
  insert into public.store_universities (store_id, university_id) select p_store, x from unnest(coalesce(p_universities, '{}')) x on conflict do nothing;
  begin
    perform public.ops_audit_add(null, 'developer', v_uid, 'store_universities', p_availability,
      jsonb_build_object('store', p_store, 'universities', to_jsonb(p_universities)));
  exception when others then null;
  end;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.set_store_universities(uuid, text, uuid[]) from public, anon;
grant execute on function public.set_store_universities(uuid, text, uuid[]) to authenticated;

-- ---------- discovery: the one place that orders shops ----------
-- p_university: a university the student is browsing for now (temporary
-- filter); null = their home university (or none for guests). Runs as the
-- caller, so stores RLS still decides which shops exist for them; only
-- approved + published, non-archived shops are listed.
drop function if exists public.discover_shops(uuid);   -- tut_campuses.sql adds a column; re-runs stay safe
create or replace function public.discover_shops(p_university uuid default null)
returns table (store_id uuid, section text, rank int, university_ids uuid[], universities text[])
language sql stable security invoker set search_path = public as $$
  with me as (
    select coalesce(p_university,
                    (select home_university_id from public.profiles where id = auth.uid())) as uni
  ),
  -- platform_config is closed to guests; the public switch is read through public_app_flags()
  flags as (select coalesce((public.public_app_flags()->>'show_partner_shops')::boolean, false) as partners),
  s as (
    select st.id, st.availability, st.rating, st.rating_count, st.seller_kind,
           coalesce(array_agg(su.university_id order by u.name) filter (where su.university_id is not null), '{}') as uids,
           coalesce(array_agg(u.name order by u.name) filter (where u.name is not null), '{}') as unames
      from public.stores st
      left join public.store_universities su on su.store_id = st.id
      left join public.universities u on u.id = su.university_id
     where st.status = 'approved' and st.is_published = true
     group by st.id
  )
  select s.id,
         case when (select uni from me) is not null and (select uni from me) = any (s.uids) then 'mine'
              when s.availability = 'everyone' then 'everyone'
              else 'other' end,
         row_number() over (order by
           case when (select uni from me) is not null and (select uni from me) = any (s.uids) then 0
                when s.availability = 'everyone' then 1 else 2 end,
           coalesce(s.rating_count, 0) desc, coalesce(s.rating, 0) desc, s.id)::int,
         s.uids, s.unames
    from s, flags
   where flags.partners or s.seller_kind = 'student'
$$;
revoke all on function public.discover_shops(uuid) from public;
grant execute on function public.discover_shops(uuid) to anon, authenticated;

revoke all on function public.ensure_university(text), public.allowed_domain_university(), public.set_home_university(),
  public.store_home_university(), public.protect_store_availability() from public, anon, authenticated;
