-- ============================================================
-- NEW (2026-09-28) — Students can attend more than one campus
--
-- profiles.campuses holds every campus a student ticked (at least one is
-- required by the customer app before they can use it — see
-- js/pages/campus-setup.js). profiles.campus_location is kept as the
-- FIRST of those campuses, so every existing screen/query that only
-- knows about one campus (My Orientation, the Staff/Developer apps)
-- keeps working unchanged.
--
-- No new RLS policy needed: students already update their own profile
-- row through the existing "profiles update own" policy, and
-- trg_prevent_role_change only guards role/store_id.
--
-- Safe to run more than once. The customer app keeps working before this
-- is run (it saves just the first campus into campus_location).
-- ============================================================
alter table public.profiles add column if not exists campuses text[] not null default '{}';

-- Carry every existing student's single campus over into the new list.
update public.profiles
   set campuses = array[campus_location]
 where campus_location is not null
   and cardinality(campuses) = 0;
