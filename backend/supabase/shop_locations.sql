-- ============================================================
-- CLICKFOOD, campus and off-campus shops (2026-10-17). Needs
-- multi_university.sql and tut_campuses.sql first.
--
-- stores.location_type  'campus' (at a university campus, as every shop so
--                       far) or 'off_campus' (a business anywhere: no
--                       university needed, a map pin is required).
-- Off-campus shops are shown to every customer (students of any university
-- and non-students) under "More places to order from", labelled Off campus.
-- Only the shop's own manager (or a developer) can change these fields: the
-- existing "stores update own" policy. Safe to run more than once.
-- ============================================================

alter table public.stores add column if not exists location_type text not null default 'campus';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'stores_location_type_check') then
    alter table public.stores add constraint stores_location_type_check check (location_type in ('campus', 'off_campus'));
  end if;
end $$;

-- an off-campus shop needs a real address and a map pin (students navigate to it)
create or replace function public.check_store_location()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.location_type = 'off_campus' then
    if new.pickup_lat is null or new.pickup_lng is null then
      raise exception 'Please put the shop on the map.' using errcode = 'P0001';
    end if;
    if new.pickup_lat not between -90 and 90 or new.pickup_lng not between -180 and 180 then
      raise exception 'The map pin is not a valid location.' using errcode = 'P0001';
    end if;
    if coalesce(btrim(new.address), '') = '' then
      raise exception 'Please enter the shop''s address.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_check_store_location on public.stores;
create trigger trg_check_store_location before insert or update of location_type, pickup_lat, pickup_lng, address on public.stores
  for each row execute function public.check_store_location();

-- discovery: off-campus shops join "available to everyone"
drop function if exists public.discover_shops(uuid);
create or replace function public.discover_shops(p_university uuid default null)
returns table (store_id uuid, section text, rank int, university_ids uuid[], universities text[], campus_ids uuid[])
language sql stable security invoker set search_path = public as $$
  with me as (
    select coalesce(p_university, (select home_university_id from public.profiles where id = auth.uid())) as uni
  ),
  flags as (select coalesce((public.public_app_flags()->>'show_partner_shops')::boolean, false) as partners),
  s as (
    select st.id, st.availability, st.location_type, st.rating, st.rating_count, st.seller_kind,
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
         case when (select uni from me) is not null and (select uni from me) = any (s.uids) and s.location_type = 'campus' then 'mine'
              when s.availability = 'everyone' or s.location_type = 'off_campus' then 'everyone' else 'other' end,
         row_number() over (order by
           case when (select uni from me) is not null and (select uni from me) = any (s.uids) and s.location_type = 'campus' then 0
                when s.availability = 'everyone' or s.location_type = 'off_campus' then 1 else 2 end,
           coalesce(s.rating_count, 0) desc, coalesce(s.rating, 0) desc, s.id)::int,
         s.uids, s.unames, s.cids
    from s, flags
   where flags.partners or s.seller_kind = 'student'
$$;
revoke all on function public.discover_shops(uuid) from public;
grant execute on function public.discover_shops(uuid) to anon, authenticated;
