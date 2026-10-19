-- =========================================================================
-- Campus Talent: view counts
-- One view per student per post (their own views don't count). Counted
-- only through record_talent_view(); nobody can write view_count directly.
-- Safe to run more than once.
-- =========================================================================

alter table public.talent_posts add column if not exists view_count int not null default 0;

create table if not exists public.talent_views (
  post_id uuid not null references public.talent_posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
alter table public.talent_views enable row level security;
-- no policies: rows are only written by record_talent_view() below

-- a new post always starts at zero views, whatever the insert says
create or replace function public.talent_zero_views()
returns trigger language plpgsql as $$
begin new.view_count := 0; return new; end $$;
drop trigger if exists trg_talent_zero_views on public.talent_posts;
create trigger trg_talent_zero_views before insert on public.talent_posts for each row execute function public.talent_zero_views();

create or replace function public.record_talent_view(p_post uuid)
returns void language plpgsql security definer set search_path = public as $$
declare added int;
begin
  if auth.uid() is null then return; end if;
  insert into public.talent_views (post_id, user_id)
  select p.id, auth.uid() from public.talent_posts p
  where p.id = p_post and p.status = 'approved' and p.user_id <> auth.uid()
    and not public.talent_blocked(auth.uid(), p.user_id)
  on conflict do nothing;
  get diagnostics added = row_count;
  if added > 0 then update public.talent_posts set view_count = view_count + 1 where id = p_post; end if;
end $$;
revoke all on function public.record_talent_view(uuid) from public, anon;
grant execute on function public.record_talent_view(uuid) to authenticated;

-- feed now also returns each post's views and status; For You also shows
-- your own posts that are still waiting for review (only to you), first
drop function if exists public.talent_feed(text, int, int);
create function public.talent_feed(p_mode text, p_offset int default 0, p_limit int default 10)
returns table (id uuid, user_id uuid, username text, kind text, storage_path text, poster_path text, caption text,
               duration_seconds numeric, like_count int, comment_count int, share_count int, view_count int, created_at timestamptz, status text,
               liked boolean, saved boolean, following boolean)
language sql stable security definer set search_path = public as $$
  select p.id, p.user_id, tp.username, p.kind, p.storage_path, p.poster_path, p.caption, p.duration_seconds,
         p.like_count, p.comment_count, p.share_count, p.view_count, p.created_at, p.status,
         exists (select 1 from public.talent_likes l where l.post_id = p.id and l.user_id = auth.uid()),
         exists (select 1 from public.talent_saves s where s.post_id = p.id and s.user_id = auth.uid()),
         exists (select 1 from public.talent_follows f where f.follower_id = auth.uid() and f.followee_id = p.user_id)
  from public.talent_posts p join public.talent_profiles tp on tp.user_id = p.user_id
  where auth.uid() is not null and not public.talent_blocked(auth.uid(), p.user_id)
    and (p.status = 'approved' or (p_mode = 'for_you' and p.status = 'pending' and p.user_id = auth.uid()))
    and (p_mode <> 'following' or exists (select 1 from public.talent_follows f where f.follower_id = auth.uid() and f.followee_id = p.user_id))
    and (p_mode <> 'trending' or p.approved_at > now() - interval '7 days')
    and (p_mode <> 'saved' or exists (select 1 from public.talent_saves s where s.post_id = p.id and s.user_id = auth.uid()))
  order by
    case when p.status = 'pending' then 0 else 1 end,
    case when p_mode = 'trending' then p.like_count + 2 * p.comment_count + 3 * p.share_count end desc nulls last,
    case when p_mode = 'for_you' then extract(epoch from p.approved_at) / 3600 + ln(1 + p.like_count + 2 * p.comment_count) * 6 end desc nulls last,
    p.approved_at desc nulls first, p.created_at desc
  offset greatest(0, p_offset) limit least(greatest(1, p_limit), 20)
$$;
revoke all on function public.talent_feed(text, int, int) from public, anon;
grant execute on function public.talent_feed(text, int, int) to authenticated;

-- profile now also returns total views
create or replace function public.talent_profile(p_username text)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when tp.user_id is null or public.talent_blocked(auth.uid(), tp.user_id) then null else jsonb_build_object(
    'user_id', tp.user_id, 'username', tp.username, 'bio', tp.bio, 'is_me', tp.user_id = auth.uid(),
    'followers', (select count(*) from public.talent_follows where followee_id = tp.user_id),
    'following', (select count(*) from public.talent_follows where follower_id = tp.user_id),
    'total_likes', (select coalesce(sum(like_count), 0) from public.talent_posts where user_id = tp.user_id and status = 'approved'),
    'total_views', (select coalesce(sum(view_count), 0) from public.talent_posts where user_id = tp.user_id and status = 'approved'),
    'posts', (select count(*) from public.talent_posts where user_id = tp.user_id and status = 'approved'),
    'i_follow', exists (select 1 from public.talent_follows where follower_id = auth.uid() and followee_id = tp.user_id)) end
  from public.talent_profiles tp where lower(tp.username) = lower(btrim(p_username)) and auth.uid() is not null
$$;
