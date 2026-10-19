-- ============================================================
-- CLICKFOOD, campuses, campus venue directory, pickup points
-- (TUT Pretoria / Tshwane, 2026-10-16). Needs multi_university.sql first.
--
-- campuses          one row per campus, stable id + stable code. Names match
--                   the text ClickFood already stores (profiles.campus_location,
--                   stores.campus_location), so existing students and shops keep
--                   working. TUT: only the six Pretoria/Tshwane campuses;
--                   eMalahleni, Mbombela and Polokwane are NOT included.
-- campus_venues     researched buildings/places with source URL, verification
--                   status and date. A venue is never a shop and never a
--                   pickup point by itself. No coordinates were verified, so
--                   none are stored.
-- pickup_points     where a shop's customers collect. Created and switched on
--                   only by a developer; none exist yet.
-- store_campuses    which campus(es) a shop serves (explicit; a shop never
--                   "operates" at a campus just because it is nearby).
-- profiles.campus_id / preferred_venue_id
--                   the student's campus (kept in step with campus_location)
--                   and an optional preferred building.
--
-- Research sources (checked 2026-10-16):
--   TUT about page            https://www.tut.ac.za/about/
--   TUT campus libraries      https://libraries.tut.ac.za/tutnew/index.php/about-lis/tutcampuslibraries.html
--   TUT iCentres              https://libraries.tut.ac.za/tutnew/index.php/services/i-centres.html
--   (per-library pages listed on each row below)
-- No official TUT source for cafeterias, food courts or restaurants could be
-- found, so none are added. Additive only; safe to run more than once.
-- ============================================================

-- ---------- campuses ----------
create table if not exists public.campuses (
  id uuid primary key default gen_random_uuid(),
  university_id uuid not null references public.universities(id) on delete cascade,
  code text not null unique check (code ~ '^[a-z0-9-]{2,60}$'),
  name text not null check (length(btrim(name)) between 2 and 80),          -- matches stored campus_location text
  full_name text not null check (length(btrim(full_name)) between 2 and 140),
  address text,
  address_verified boolean not null default false,
  region text,
  latitude numeric(9,6), longitude numeric(9,6),
  source_url text,
  notes text,
  verification text not null default 'unverified' check (verification in ('verified_current', 'historical_unknown', 'unverified', 'closed')),
  last_verified date,
  active boolean not null default true,
  sort int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (university_id, name)
);
create index if not exists campuses_university on public.campuses (university_id, active);

do $$
declare tut uuid := public.ensure_university('Tshwane University of Technology');
        up uuid := public.ensure_university('University of Pretoria');
        lib text := 'https://libraries.tut.ac.za/tutnew/index.php/component/content/article/';
begin
  insert into public.campuses (university_id, code, name, full_name, address, address_verified, region, source_url, notes, verification, last_verified, sort) values
   (tut, 'tut-pretoria', 'Pretoria', 'Pretoria Campus', 'Staatsartillerie Road, Pretoria West, 0183', false, 'Tshwane',
    'https://www.tut.ac.za/about/', 'Campus listed on the official TUT about page. Street address only found on directory sites (e.g. unirank.org), not on an official TUT page.', 'verified_current', '2026-10-16', 10),
   (tut, 'tut-arcadia', 'Arcadia', 'Arcadia Campus', '175 Nelson Mandela Drive, Pretoria', true, 'Tshwane',
    lib || '90-arcadia-science-library.html', 'Address from the official Arcadia (Science) Library page.', 'verified_current', '2026-10-16', 20),
   (tut, 'tut-arts', 'Arts', 'Arts Campus (Arts and Design Learning Site)', '24 Du Toit Street, Pretoria', true, 'Tshwane',
    lib || '96-arts-design-library.html', 'Official library page names it the "Arts and Design Learning Site". Directory sites add "corner of Du Toit and Struben Streets" (not on the official page).', 'verified_current', '2026-10-16', 30),
   (tut, 'tut-ga-rankuwa', 'Ga-Rankuwa', 'Ga-Rankuwa Campus', '2728 Botsi Street, Zone 2, Ga-Rankuwa', true, 'Tshwane',
    'https://libraries.tut.ac.za/tutnew/index.php?option=com_content&view=article&layout=edit&id=94', 'Official library page: "2728 Botsi St, Zone 2, Garankuwa". A directory site says 2827 Botsi Street; the official number is used.', 'verified_current', '2026-10-16', 40),
   (tut, 'tut-soshanguve-north', 'Soshanguve North', 'Soshanguve North Campus', 'Aubrey Matlala Drive, Block H, Soshanguve', true, 'Tshwane',
    lib || '89-the-soshanguve-north-library.html', 'Official library page: "Aubrey Matlala Drive in Soshanguve Block H". Separate campus from Soshanguve South.', 'verified_current', '2026-10-16', 50),
   (tut, 'tut-soshanguve-south', 'Soshanguve South', 'Soshanguve South Campus', '2 Aubrey Matlala Road, Block K, Soshanguve', true, 'Tshwane',
    lib || '88-soshanguve-south-library.html', 'Official library page: "2 Aubrey Matlala Road, Block K Soshanguve". Separate campus from Soshanguve North.', 'verified_current', '2026-10-16', 60)
  on conflict (code) do nothing;
  -- UP: the campus list ClickFood already used (names only; not re-researched in this phase)
  insert into public.campuses (university_id, code, name, full_name, notes, verification, sort) values
   (up, 'up-hatfield', 'Hatfield', 'Hatfield Campus', 'From the existing ClickFood campus list.', 'unverified', 10),
   (up, 'up-hillcrest', 'Hillcrest', 'Hillcrest Campus', 'From the existing ClickFood campus list.', 'unverified', 20),
   (up, 'up-groenkloof', 'Groenkloof', 'Groenkloof Campus', 'From the existing ClickFood campus list.', 'unverified', 30),
   (up, 'up-prinshof', 'Prinshof', 'Prinshof Campus', 'From the existing ClickFood campus list.', 'unverified', 40),
   (up, 'up-mamelodi', 'Mamelodi', 'Mamelodi Campus', 'From the existing ClickFood campus list.', 'unverified', 50),
   (up, 'up-onderstepoort', 'Onderstepoort', 'Onderstepoort Campus', 'From the existing ClickFood campus list.', 'unverified', 60),
   (up, 'up-gibs', 'GIBS', 'GIBS Campus', 'From the existing ClickFood campus list.', 'unverified', 70)
  on conflict (code) do nothing;
end $$;

-- the campus list everything else reads (sign-up, profile, student sellers)
create or replace function public.university_campuses(p_university text)
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(c.name order by c.sort, c.name), array[]::text[])
    from public.campuses c join public.universities u on u.id = c.university_id
   where lower(u.name) = lower(btrim(coalesce(p_university, ''))) and c.active
$$;

-- ---------- venues ----------
create table if not exists public.campus_venues (
  id uuid primary key default gen_random_uuid(),
  campus_id uuid not null references public.campuses(id) on delete cascade,
  code text not null unique check (code ~ '^[a-z0-9-]{2,80}$'),
  name text not null check (length(btrim(name)) between 2 and 120),
  alt_names text[] not null default '{}',
  category text not null check (category in ('academic_building', 'lecture_hall', 'library', 'computer_centre', 'student_centre', 'cafeteria',
                                             'food_court', 'restaurant', 'administrative', 'residence', 'pickup_point', 'other')),
  building_number text,
  building_name text,
  rooms text,
  address text,
  area text,
  latitude numeric(9,6), longitude numeric(9,6),
  description text check (description is null or length(description) <= 400),
  source_url text,
  source_url_2 text,
  verification text not null default 'unverified' check (verification in ('verified_current', 'historical_unknown', 'unverified', 'closed')),
  last_verified date,
  pickup_suitable boolean not null default false,   -- could be considered; NOT an active pickup point
  is_food_service boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists campus_venues_campus on public.campus_venues (campus_id, category);
-- one record per real place: same campus + same building number + same category can't repeat
create unique index if not exists campus_venues_one_place on public.campus_venues (campus_id, category, lower(coalesce(building_number, name)));

do $$
declare
  c record; ic text := 'https://libraries.tut.ac.za/tutnew/index.php/services/i-centres.html';
  lib text := 'https://libraries.tut.ac.za/tutnew/index.php/component/content/article/';
  libs text := 'https://libraries.tut.ac.za/tutnew/index.php/about-lis/tutcampuslibraries.html';
begin
  for c in select id, code from public.campuses where code like 'tut-%' loop
    if c.code = 'tut-pretoria' then
      insert into public.campus_venues (campus_id, code, name, category, building_number, rooms, description, source_url, source_url_2, verification, last_verified, pickup_suitable) values
       (c.id, 'tut-pretoria-library', 'Pretoria Campus Library', 'library', null, null, 'Library and Information Services. Auditorium on the 2nd floor; staff conference room on the 1st floor.',
        lib || '91-pretoria-library.html', libs, 'verified_current', '2026-10-16', false),
       (c.id, 'tut-pretoria-icentre-44', 'iCentre, Building 44', 'computer_centre', '44', '44-001', 'Student computer centre (iCentre).', ic, null, 'verified_current', '2026-10-16', false),
       (c.id, 'tut-pretoria-icentre-30', 'iCentre, Building 30', 'computer_centre', '30', '30-117, 30-119', 'Student computer centres (iCentres).', ic, null, 'verified_current', '2026-10-16', false),
       (c.id, 'tut-pretoria-icentre-13', 'iCentre, Building 13', 'computer_centre', '13', '13-217', 'Student computer centre (iCentre).', ic, null, 'verified_current', '2026-10-16', false),
       (c.id, 'tut-pretoria-icentre-6', 'iCentre, Building 6', 'computer_centre', '6', '6-114', 'Student computer centre (iCentre).', ic, null, 'verified_current', '2026-10-16', false),
       -- directory sites only: kept as a research record, hidden from the directory
       (c.id, 'tut-pretoria-admissions-21', 'Central Admissions Office, Building 21', 'administrative', '21', '21-LG20', 'Hand-delivery point for applications according to directory sites. Not confirmed on an official TUT page.',
        'https://mabumbe.com/kb/tshwane-university-of-technology-details/', 'https://jupiter.tut.ac.za/staffportal/file_store/files/743/staff.pdf', 'unverified', '2026-10-16', false)
      on conflict (code) do nothing;
    elsif c.code = 'tut-arcadia' then
      insert into public.campus_venues (campus_id, code, name, alt_names, category, building_number, address, description, source_url, source_url_2, verification, last_verified) values
       (c.id, 'tut-arcadia-library', 'Arcadia (Science) Library', '{"Arcadia Campus Library"}', 'library', '2', '175 Nelson Mandela Drive, Pretoria',
        'Library in Building 2, with an iCentre (student computers) inside.', lib || '90-arcadia-science-library.html', ic, 'verified_current', '2026-10-16')
      on conflict (code) do nothing;
    elsif c.code = 'tut-arts' then
      insert into public.campus_venues (campus_id, code, name, alt_names, category, address, description, source_url, source_url_2, verification, last_verified) values
       (c.id, 'tut-arts-library', 'Arts & Design Library', '{"Arts Campus Library"}', 'library', '24 Du Toit Street, Pretoria',
        'Library on the Arts and Design Learning Site, with an iCentre on the ground floor.', lib || '96-arts-design-library.html', ic, 'verified_current', '2026-10-16')
      on conflict (code) do nothing;
    elsif c.code = 'tut-ga-rankuwa' then
      insert into public.campus_venues (campus_id, code, name, alt_names, category, building_number, address, description, source_url, source_url_2, verification, last_verified) values
       (c.id, 'tut-ga-rankuwa-library', 'Ga-Rankuwa Library', '{"Garankuwa Library"}', 'library', '2', '2728 Botsi Street, Zone 2, Ga-Rankuwa',
        'Library in Building 2, with an iCentre on level 1.', 'https://libraries.tut.ac.za/tutnew/index.php?option=com_content&view=article&layout=edit&id=94', ic, 'verified_current', '2026-10-16')
      on conflict (code) do nothing;
    elsif c.code = 'tut-soshanguve-north' then
      insert into public.campus_venues (campus_id, code, name, category, building_number, rooms, address, description, source_url, source_url_2, verification, last_verified) values
       (c.id, 'tut-sosh-north-library', 'Soshanguve North Library', 'library', null, null, 'Aubrey Matlala Drive, Block H, Soshanguve',
        'Library with an iCentre (student computers) inside.', lib || '89-the-soshanguve-north-library.html', ic, 'verified_current', '2026-10-16'),
       (c.id, 'tut-sosh-north-icentre-16', 'iCentres, Building 16', 'computer_centre', '16', '16-113, 16-G05', null, 'Student computer centres (iCentres).', ic, null, 'verified_current', '2026-10-16')
      on conflict (code) do nothing;
    elsif c.code = 'tut-soshanguve-south' then
      insert into public.campus_venues (campus_id, code, name, category, building_number, address, description, source_url, source_url_2, verification, last_verified) values
       (c.id, 'tut-sosh-south-library', 'Soshanguve South Library', 'library', '6', '2 Aubrey Matlala Road, Block K, Soshanguve',
        'Library on the ground and first floors of Building 6. The iCentre is also in Building 6.', lib || '88-soshanguve-south-library.html', ic, 'verified_current', '2026-10-16')
      on conflict (code) do nothing;
    end if;
  end loop;
end $$;

-- ---------- shops <-> campuses, shop's building ----------
create table if not exists public.store_campuses (
  store_id uuid not null references public.stores(id) on delete cascade,
  campus_id uuid not null references public.campuses(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (store_id, campus_id)
);
create index if not exists store_campuses_campus on public.store_campuses (campus_id);
alter table public.stores add column if not exists venue_id uuid references public.campus_venues(id) on delete set null;
-- existing shops: their own campus text, at their own university (never guessed)
insert into public.store_campuses (store_id, campus_id)
select s.id, c.id from public.stores s
  join public.universities u on lower(u.name) = lower(s.university)
  join public.campuses c on c.university_id = u.id and lower(c.name) = lower(s.campus_location)
on conflict do nothing;
create or replace function public.store_home_campus()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.campus_location is not null and (tg_op = 'INSERT' or new.campus_location is distinct from old.campus_location or new.university is distinct from old.university) then
    insert into public.store_campuses (store_id, campus_id)
    select new.id, c.id from public.campuses c join public.universities u on u.id = c.university_id
     where lower(u.name) = lower(coalesce(new.university, '')) and lower(c.name) = lower(new.campus_location)
    on conflict do nothing;
  end if;
  return null;
end $$;
drop trigger if exists trg_store_home_campus on public.stores;
create trigger trg_store_home_campus after insert or update of campus_location, university on public.stores
  for each row execute function public.store_home_campus();

-- only a developer changes which building a shop is in (managers keep editing
-- their own campus text as before; the link follows it via the trigger above)
create or replace function public.protect_store_venue()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.venue_id is distinct from old.venue_id
     and coalesce(current_setting('request.jwt.claims', true), '') <> ''
     and public."current_role"() is distinct from 'developer' then
    new.venue_id := old.venue_id;
  end if;
  return new;
end $$;
drop trigger if exists trg_protect_store_venue on public.stores;
create trigger trg_protect_store_venue before update on public.stores
  for each row execute function public.protect_store_venue();

-- ---------- pickup points ----------
create table if not exists public.pickup_points (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  campus_id uuid not null references public.campuses(id) on delete cascade,
  venue_id uuid references public.campus_venues(id) on delete set null,
  name text not null check (length(btrim(name)) between 2 and 120),
  details text check (details is null or length(details) <= 300),
  active boolean not null default false,          -- off until a developer switches it on
  authorised_by uuid references public.profiles(id) on delete set null,
  authorised_at timestamptz,
  created_at timestamptz not null default now(),
  unique (store_id, name)
);
create index if not exists pickup_points_store on public.pickup_points (store_id) where active;

-- ---------- student campus + preferred building ----------
alter table public.profiles add column if not exists campus_id uuid references public.campuses(id) on delete set null;
alter table public.profiles add column if not exists preferred_venue_id uuid references public.campus_venues(id) on delete set null;
-- campus_id follows the campus the student picks (campus_location text), at
-- the university of their student email. A preferred building must be a
-- current, verified place on that campus. Never blocks: an unknown campus
-- name just leaves campus_id empty.
create or replace function public.sync_profile_campus()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.campus_location is distinct from old.campus_location or new.university is distinct from old.university
     or (new.campus_id is null and new.campus_location is not null) then   -- also links existing students (backfill)
    select c.id into new.campus_id from public.campuses c join public.universities u on u.id = c.university_id
     where lower(u.name) = lower(coalesce(new.university, '')) and lower(c.name) = lower(coalesce(new.campus_location, '')) and c.active;
    if not found then new.campus_id := null; end if;
  elsif new.campus_id is distinct from old.campus_id then
    new.campus_id := old.campus_id;   -- set through campus_location only
  end if;
  if new.preferred_venue_id is not null and (tg_op = 'INSERT' or new.preferred_venue_id is distinct from old.preferred_venue_id or new.campus_id is distinct from old.campus_id) then
    if new.campus_id is null or not exists (select 1 from public.campus_venues v where v.id = new.preferred_venue_id and v.campus_id = new.campus_id
                                            and v.active and v.verification = 'verified_current') then
      if tg_op = 'UPDATE' and new.preferred_venue_id is distinct from old.preferred_venue_id then
        raise exception 'Please choose a building on your campus.' using errcode = 'P0001';
      end if;
      new.preferred_venue_id := null;   -- campus changed: the old building no longer applies
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_sync_profile_campus on public.profiles;
create trigger trg_sync_profile_campus before insert or update of campus_location, university, campus_id, preferred_venue_id on public.profiles
  for each row execute function public.sync_profile_campus();
update public.profiles set campus_location = campus_location where campus_location is not null and campus_id is null;

-- ---------- reading (RLS) ----------
alter table public.campuses enable row level security;
alter table public.campus_venues enable row level security;
alter table public.store_campuses enable row level security;
alter table public.pickup_points enable row level security;
revoke all on public.campuses, public.campus_venues, public.store_campuses, public.pickup_points from anon, authenticated;
grant select on public.campuses, public.campus_venues, public.store_campuses, public.pickup_points to anon, authenticated;
drop policy if exists "campuses read" on public.campuses;
create policy "campuses read" on public.campuses for select to anon, authenticated
  using (active or public."current_role"() = 'developer');
drop policy if exists "campus venues read" on public.campus_venues;
-- students see current, verified places; developers see every research record
create policy "campus venues read" on public.campus_venues for select to anon, authenticated
  using ((active and verification = 'verified_current') or public."current_role"() = 'developer');
drop policy if exists "store campuses read" on public.store_campuses;
create policy "store campuses read" on public.store_campuses for select to anon, authenticated
  using (exists (select 1 from public.stores s where s.id = store_id));
drop policy if exists "pickup points read" on public.pickup_points;
create policy "pickup points read" on public.pickup_points for select to anon, authenticated
  using ((active and exists (select 1 from public.stores s where s.id = store_id))
         or public."current_role"() = 'developer'
         or exists (select 1 from public.stores s where s.id = store_id and s.manager_id = auth.uid()));

-- ---------- developer changes (all checked here, all audited) ----------
create or replace function public.dev_audit(p_action text, p_meta jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.ops_audit_add(null, 'developer', auth.uid(), p_action, 'saved', p_meta);
exception when others then null;
end $$;

-- add or edit a venue (p_id null = new)
create or replace function public.dev_save_venue(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid := p_id; v_campus uuid := nullif(p->>'campus_id', '')::uuid; v_code text;
begin
  if public."current_role"() is distinct from 'developer' then return jsonb_build_object('ok', false, 'error', 'Not allowed.'); end if;
  if coalesce(btrim(p->>'name'), '') = '' then return jsonb_build_object('ok', false, 'error', 'Enter the venue name.'); end if;
  if coalesce(p->>'verification', 'unverified') not in ('verified_current', 'historical_unknown', 'unverified', 'closed') then return jsonb_build_object('ok', false, 'error', 'Bad verification status.'); end if;
  if v_id is null then
    if not exists (select 1 from public.campuses where id = v_campus) then return jsonb_build_object('ok', false, 'error', 'Choose a campus.'); end if;
    v_code := left(regexp_replace(lower((select code from public.campuses where id = v_campus) || '-' || btrim(p->>'name')), '[^a-z0-9]+', '-', 'g'), 70)
              || '-' || substr(md5(random()::text), 1, 4);
    insert into public.campus_venues (campus_id, code, name, category, building_number, rooms, address, description, source_url, verification, last_verified, pickup_suitable, is_food_service, active)
    values (v_campus, v_code, btrim(p->>'name'), coalesce(p->>'category', 'other'), nullif(btrim(p->>'building_number'), ''), nullif(btrim(p->>'rooms'), ''),
            nullif(btrim(p->>'address'), ''), nullif(btrim(p->>'description'), ''), nullif(btrim(p->>'source_url'), ''), coalesce(p->>'verification', 'unverified'),
            nullif(p->>'last_verified', '')::date, coalesce((p->>'pickup_suitable')::boolean, false), coalesce((p->>'is_food_service')::boolean, false), coalesce((p->>'active')::boolean, true))
    returning id into v_id;
  else
    update public.campus_venues set
      name = btrim(p->>'name'), category = coalesce(p->>'category', category),
      building_number = nullif(btrim(p->>'building_number'), ''), rooms = nullif(btrim(p->>'rooms'), ''),
      address = nullif(btrim(p->>'address'), ''), description = nullif(btrim(p->>'description'), ''),
      source_url = nullif(btrim(p->>'source_url'), ''), verification = coalesce(p->>'verification', verification),
      last_verified = coalesce(nullif(p->>'last_verified', '')::date, last_verified),
      pickup_suitable = coalesce((p->>'pickup_suitable')::boolean, pickup_suitable),
      is_food_service = coalesce((p->>'is_food_service')::boolean, is_food_service),
      active = coalesce((p->>'active')::boolean, active), updated_at = now()
    where id = v_id;
    if not found then return jsonb_build_object('ok', false, 'error', 'Venue not found.'); end if;
  end if;
  perform public.dev_audit('venue_saved', jsonb_build_object('venue', v_id, 'verification', p->>'verification'));
  return jsonb_build_object('ok', true, 'id', v_id);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'That place is already in the directory.');
when check_violation or invalid_text_representation then
  return jsonb_build_object('ok', false, 'error', 'Please check the venue details.');
end $$;

-- which campuses a shop serves, and its building
create or replace function public.set_store_campuses(p_store uuid, p_campuses uuid[], p_venue uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if public."current_role"() is distinct from 'developer' then return jsonb_build_object('ok', false, 'error', 'Not allowed.'); end if;
  if not exists (select 1 from public.stores where id = p_store) then return jsonb_build_object('ok', false, 'error', 'Shop not found.'); end if;
  if exists (select 1 from unnest(coalesce(p_campuses, '{}')) x where not exists (select 1 from public.campuses c where c.id = x)) then
    return jsonb_build_object('ok', false, 'error', 'Unknown campus.');
  end if;
  if p_venue is not null and not exists (select 1 from public.campus_venues v where v.id = p_venue and v.campus_id = any (coalesce(p_campuses, '{}'))) then
    return jsonb_build_object('ok', false, 'error', 'The building must be on one of the shop''s campuses.');
  end if;
  delete from public.store_campuses where store_id = p_store and not (campus_id = any (coalesce(p_campuses, '{}')));
  insert into public.store_campuses (store_id, campus_id) select p_store, x from unnest(coalesce(p_campuses, '{}')) x on conflict do nothing;
  update public.stores set venue_id = p_venue where id = p_store;
  perform public.dev_audit('store_campuses', jsonb_build_object('store', p_store, 'campuses', to_jsonb(p_campuses), 'venue', p_venue));
  return jsonb_build_object('ok', true);
end $$;

-- add / switch on / switch off a pickup point (only for a shop's own campus)
create or replace function public.dev_save_pickup_point(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid := p_id; v_store uuid := nullif(p->>'store_id', '')::uuid; v_campus uuid := nullif(p->>'campus_id', '')::uuid;
        v_venue uuid := nullif(p->>'venue_id', '')::uuid; v_active boolean := coalesce((p->>'active')::boolean, false);
begin
  if public."current_role"() is distinct from 'developer' then return jsonb_build_object('ok', false, 'error', 'Not allowed.'); end if;
  if v_id is null then
    if not exists (select 1 from public.store_campuses where store_id = v_store and campus_id = v_campus) then
      return jsonb_build_object('ok', false, 'error', 'The shop must serve that campus first.');
    end if;
    if v_venue is not null and not exists (select 1 from public.campus_venues where id = v_venue and campus_id = v_campus) then
      return jsonb_build_object('ok', false, 'error', 'The building must be on that campus.');
    end if;
    insert into public.pickup_points (store_id, campus_id, venue_id, name, details, active, authorised_by, authorised_at)
    values (v_store, v_campus, v_venue, btrim(p->>'name'), nullif(btrim(p->>'details'), ''), v_active, case when v_active then auth.uid() end, case when v_active then now() end)
    returning id into v_id;
  else
    update public.pickup_points set active = v_active,
      authorised_by = case when v_active then auth.uid() else authorised_by end,
      authorised_at = case when v_active then now() else authorised_at end
    where id = v_id;
    if not found then return jsonb_build_object('ok', false, 'error', 'Pickup point not found.'); end if;
  end if;
  perform public.dev_audit('pickup_point', jsonb_build_object('pickup_point', v_id, 'active', v_active));
  return jsonb_build_object('ok', true, 'id', v_id);
exception when unique_violation then return jsonb_build_object('ok', false, 'error', 'That shop already has a pickup point with this name.');
when check_violation or not_null_violation or invalid_text_representation then return jsonb_build_object('ok', false, 'error', 'Please check the pickup point details.');
end $$;

-- an order that names a pickup point must use an ACTIVE one of that shop
create or replace function public.validate_order_pickup_point()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_pp text := new.delivery_location->>'pickupPointId';
begin
  if v_pp is null or v_pp = '' then return new; end if;
  if v_pp !~ '^[0-9a-fA-F-]{36}$' or not exists (select 1 from public.pickup_points p where p.id = v_pp::uuid and p.store_id = new.store_id and p.active) then
    raise exception 'That pickup point is not available for this shop.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_validate_order_pickup_point on public.orders;
create trigger trg_validate_order_pickup_point before insert on public.orders
  for each row execute function public.validate_order_pickup_point();

-- shop discovery also returns each shop's campus ids (one request still)
drop function if exists public.discover_shops(uuid);
create or replace function public.discover_shops(p_university uuid default null)
returns table (store_id uuid, section text, rank int, university_ids uuid[], universities text[], campus_ids uuid[])
language sql stable security invoker set search_path = public as $$
  with me as (
    select coalesce(p_university, (select home_university_id from public.profiles where id = auth.uid())) as uni
  ),
  flags as (select coalesce((public.public_app_flags()->>'show_partner_shops')::boolean, false) as partners),
  s as (
    select st.id, st.availability, st.rating, st.rating_count, st.seller_kind,
           coalesce(array_agg(distinct su.university_id) filter (where su.university_id is not null), '{}') as uids,
           coalesce(array_agg(distinct u.name) filter (where u.name is not null), '{}') as unames,
           coalesce((select array_agg(sc.campus_id) from public.store_campuses sc where sc.store_id = st.id), '{}') as cids
      from public.stores st
      left join public.store_universities su on su.store_id = st.id
      left join public.universities u on u.id = su.university_id
     where st.status = 'approved' and st.is_published = true
     group by st.id
  )
  select s.id,
         case when (select uni from me) is not null and (select uni from me) = any (s.uids) then 'mine'
              when s.availability = 'everyone' then 'everyone' else 'other' end,
         row_number() over (order by
           case when (select uni from me) is not null and (select uni from me) = any (s.uids) then 0
                when s.availability = 'everyone' then 1 else 2 end,
           coalesce(s.rating_count, 0) desc, coalesce(s.rating, 0) desc, s.id)::int,
         s.uids, s.unames, s.cids
    from s, flags
   where flags.partners or s.seller_kind = 'student'
$$;
revoke all on function public.discover_shops(uuid) from public;
grant execute on function public.discover_shops(uuid) to anon, authenticated;

revoke all on function public.dev_save_venue(uuid, jsonb), public.set_store_campuses(uuid, uuid[], uuid), public.dev_save_pickup_point(uuid, jsonb) from public, anon;
grant execute on function public.dev_save_venue(uuid, jsonb), public.set_store_campuses(uuid, uuid[], uuid), public.dev_save_pickup_point(uuid, jsonb) to authenticated;
revoke all on function public.dev_audit(text, jsonb), public.store_home_campus(), public.protect_store_venue(), public.sync_profile_campus(),
  public.validate_order_pickup_point() from public, anon, authenticated;
