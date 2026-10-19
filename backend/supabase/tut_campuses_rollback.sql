-- Rollback for tut_campuses.sql. Removes campuses/venues/pickup points and the
-- links to them; profiles.campus_location and stores.campus_location (the
-- text the app used before) are untouched. Restores the old campus list.
drop trigger if exists trg_validate_order_pickup_point on public.orders;
drop function if exists public.validate_order_pickup_point();
drop function if exists public.dev_save_pickup_point(uuid, jsonb);
drop function if exists public.set_store_campuses(uuid, uuid[], uuid);
drop function if exists public.dev_save_venue(uuid, jsonb);
drop function if exists public.dev_audit(text, jsonb);
drop trigger if exists trg_sync_profile_campus on public.profiles;
drop function if exists public.sync_profile_campus();
alter table public.profiles drop column if exists preferred_venue_id;
alter table public.profiles drop column if exists campus_id;
drop table if exists public.pickup_points;
drop trigger if exists trg_protect_store_venue on public.stores;
drop function if exists public.protect_store_venue();
drop trigger if exists trg_store_home_campus on public.stores;
drop function if exists public.store_home_campus();
alter table public.stores drop column if exists venue_id;
drop table if exists public.store_campuses;
drop table if exists public.campus_venues;
drop table if exists public.campuses;
create or replace function public.university_campuses(p_university text)
returns text[] language sql immutable as $$
  select case p_university
    when 'University of Pretoria' then array['Hatfield', 'Hillcrest', 'Groenkloof', 'Prinshof', 'Mamelodi', 'Onderstepoort', 'GIBS']
    when 'Tshwane University of Technology' then array['Pretoria', 'Arcadia', 'Arts', 'Soshanguve South', 'Soshanguve North', 'Ga-Rankuwa', 'eMalahleni', 'Mbombela', 'Polokwane']
    else array[]::text[]
  end
$$;
-- discover_shops without campus ids (as in multi_university.sql)
drop function if exists public.discover_shops(uuid);
-- then re-run the discover_shops part of multi_university.sql
