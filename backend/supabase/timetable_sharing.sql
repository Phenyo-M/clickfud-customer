-- ============================================================
-- NEW (2026-09-29) — Share a timetable with friends by link.
--
-- A student taps "Share" on My Timetable: create_timetable_share()
-- stores a SNAPSHOT of their classes (not a live view) and returns an
-- unguessable id, sent as clickfud…/?timetable=<id> (WhatsApp etc.).
-- The friend opens it, previews it (get_timetable_share), and on accept
-- (accept_timetable_share) the classes are COPIED into the friend's own
-- timetable_entries — so reminders, directions and editing all work
-- exactly like classes they typed in themselves.
--
-- Privacy:
--   - timetable_entries RLS is unchanged: nobody can read anyone else's
--     timetable. Only what the owner chose to share, frozen at that
--     moment, is visible — and only to someone holding the link.
--   - personal `notes` are never included in a share.
--   - links expire after 30 days; the owner can revoke (revoked=true).
--   - no one can list shares: the table has no select policy for anyone
--     but the owner; previews/accepts go through the functions below.
-- ============================================================
create table if not exists public.timetable_shares (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  owner_name text,
  entries jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  revoked boolean not null default false,
  accept_count int not null default 0
);
create index if not exists idx_timetable_shares_owner on public.timetable_shares(owner_id, created_at desc);
alter table public.timetable_shares enable row level security;

drop policy if exists "timetable shares owner select" on public.timetable_shares;
create policy "timetable shares owner select" on public.timetable_shares
  for select using (owner_id = (select auth.uid()));
drop policy if exists "timetable shares owner revoke" on public.timetable_shares;
create policy "timetable shares owner revoke" on public.timetable_shares
  for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
-- No insert/delete policies: shares are only ever created by the function below.

-- ---- create: snapshot the caller's own classes ----
create or replace function public.create_timetable_share()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_entries jsonb;
  v_name text;
  v_id uuid;
begin
  if v_uid is null then raise exception 'Please sign in to share your timetable.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'module', module, 'module_code', module_code, 'class_type', class_type,
      'day_of_week', day_of_week, 'specific_date', specific_date,
      'start_time', to_char(start_time, 'HH24:MI'), 'end_time', to_char(end_time, 'HH24:MI'),
      'campus', campus, 'venue', venue, 'lecturer', lecturer
    ) order by day_of_week, start_time), '[]'::jsonb)
    into v_entries
    from public.timetable_entries where student_id = v_uid;
  if jsonb_array_length(v_entries) = 0 then
    raise exception 'Your timetable is empty — add your classes before sharing.';
  end if;
  if (select count(*) from public.timetable_shares where owner_id = v_uid and created_at > now() - interval '1 day') >= 30 then
    raise exception 'You have shared your timetable many times today — please try again tomorrow.';
  end if;
  select nullif(split_part(coalesce(name, ''), ' ', 1), '') into v_name from public.profiles where id = v_uid;
  insert into public.timetable_shares (owner_id, owner_name, entries)
    values (v_uid, v_name, v_entries) returning id into v_id;
  return v_id;
end;
$$;

-- ---- preview: anyone holding the link (signed in or not) ----
create or replace function public.get_timetable_share(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'owner_name', coalesce(s.owner_name, 'A friend'),
    'entries', s.entries,
    'class_count', jsonb_array_length(s.entries),
    'expires_at', s.expires_at,
    'is_own', s.owner_id = auth.uid()
  )
  from public.timetable_shares s
  where s.id = p_id and not s.revoked and s.expires_at > now();
$$;

-- ---- accept: copy into the CALLER's own timetable ----
-- p_mode: 'add' (keep existing classes, skip exact duplicates) or
--         'replace' (remove the caller's existing classes first).
create or replace function public.accept_timetable_share(p_id uuid, p_mode text default 'add')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_share public.timetable_shares;
  v_inserted int;
begin
  if v_uid is null then raise exception 'Please sign in to add this timetable.'; end if;
  if p_mode not in ('add', 'replace') then raise exception 'Invalid option.'; end if;
  select * into v_share from public.timetable_shares where id = p_id and not revoked and expires_at > now();
  if not found then raise exception 'This timetable link has expired or is no longer available.'; end if;
  if v_share.owner_id = v_uid then raise exception 'This is your own timetable.'; end if;

  if p_mode = 'replace' then
    delete from public.timetable_entries where student_id = v_uid;
  end if;

  with src as (
    select e->>'module' module, nullif(e->>'module_code', '') module_code, e->>'class_type' class_type,
           (e->>'day_of_week')::smallint day_of_week, nullif(e->>'specific_date', '')::date specific_date,
           (e->>'start_time')::time start_time, (e->>'end_time')::time end_time,
           e->>'campus' campus, e->>'venue' venue, nullif(e->>'lecturer', '') lecturer
    from jsonb_array_elements(v_share.entries) e
  ), ins as (
    insert into public.timetable_entries (student_id, module, module_code, class_type, day_of_week, specific_date, start_time, end_time, campus, venue, lecturer)
    select v_uid, s.module, s.module_code, s.class_type, s.day_of_week, s.specific_date, s.start_time, s.end_time, s.campus, s.venue, s.lecturer
    from src s
    where not exists (
      select 1 from public.timetable_entries t
      where t.student_id = v_uid and t.module = s.module and t.class_type = s.class_type
        and t.day_of_week = s.day_of_week and t.specific_date is not distinct from s.specific_date
        and t.start_time = s.start_time and t.end_time = s.end_time and t.venue = s.venue
    )
    returning 1
  )
  select count(*) into v_inserted from ins;

  update public.timetable_shares set accept_count = accept_count + 1 where id = p_id;
  return v_inserted;
end;
$$;

revoke all on function public.create_timetable_share() from public;
revoke all on function public.get_timetable_share(uuid) from public;
revoke all on function public.accept_timetable_share(uuid, text) from public;
grant execute on function public.create_timetable_share() to authenticated;
grant execute on function public.get_timetable_share(uuid) to anon, authenticated;
grant execute on function public.accept_timetable_share(uuid, text) to authenticated;
