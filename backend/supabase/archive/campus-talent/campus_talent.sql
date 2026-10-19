-- =========================================================================
-- ClickFood — Campus Talent (2026-10-01)
-- Students share short videos and photos. Separate from food ordering.
--
--  * Files live in Supabase Storage (private bucket "talent"), never in the
--    database. The database keeps metadata only: who, file path, type,
--    caption, size, length, status, counts.
--  * Moderation first: every upload starts "pending" and is only visible to
--    its owner and the platform admin (developer) until approved. Statuses:
--    pending / approved / rejected / removed. Reported content is queued.
--  * Limits (checked here and by the bucket): videos up to 60 seconds and
--    50 MB, photos up to 8 MB, 5 uploads per day, 10 pending at a time.
--  * Likes, comments, saves, shares and follows are real rows; the counts on a
--    post are kept by triggers, never written by the app.
--  * Blocking hides both people's posts and comments from each other.
--  * Signed links: the storage rules only let someone open a file when its
--    post is approved (or it's their own, or they're the moderator).
-- Safe to run more than once.
-- =========================================================================

-- ---------- Creator handle ----------
create table if not exists public.talent_profiles (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  username text not null check (username = btrim(username) and char_length(username) between 1 and 30 and username !~ '[[:cntrl:]]'),
  bio text check (bio is null or char_length(bio) <= 150),
  created_at timestamptz not null default now()
);
create unique index if not exists talent_profiles_username_lower_uniq on public.talent_profiles (lower(username));

-- ---------- Posts ----------
create table if not exists public.talent_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('video', 'photo')),
  storage_path text not null unique,
  poster_path text,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  duration_seconds numeric(6,2),
  caption text check (caption is null or char_length(caption) <= 300),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'removed')),
  status_reason text,
  like_count int not null default 0,
  comment_count int not null default 0,
  share_count int not null default 0,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  constraint talent_posts_limits check (
    (kind = 'video' and mime_type in ('video/mp4', 'video/webm', 'video/quicktime') and size_bytes <= 50 * 1024 * 1024
       and duration_seconds is not null and duration_seconds > 0 and duration_seconds <= 60)
    or (kind = 'photo' and mime_type in ('image/jpeg', 'image/png', 'image/webp') and size_bytes <= 8 * 1024 * 1024))
);
create index if not exists talent_posts_feed_idx on public.talent_posts (status, created_at desc);
create index if not exists talent_posts_user_idx on public.talent_posts (user_id, created_at desc);

create table if not exists public.talent_likes (
  post_id uuid not null references public.talent_posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create table if not exists public.talent_saves (
  post_id uuid not null references public.talent_posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create table if not exists public.talent_shares (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.talent_posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists public.talent_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.talent_posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  parent_id uuid references public.talent_comments (id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 500),
  status text not null default 'visible' check (status in ('visible', 'removed')),
  created_at timestamptz not null default now()
);
create index if not exists talent_comments_post_idx on public.talent_comments (post_id, created_at);
create table if not exists public.talent_follows (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  followee_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
create index if not exists talent_follows_followee_idx on public.talent_follows (followee_id);
create table if not exists public.talent_blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create table if not exists public.talent_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  target_type text not null check (target_type in ('post', 'comment', 'user')),
  target_id uuid not null,
  reason text not null check (reason in ('nudity', 'violence', 'bullying', 'hate', 'spam', 'self_harm', 'other')),
  note text check (note is null or char_length(note) <= 300),
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  handled_by uuid references public.profiles (id) on delete set null,
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (reporter_id, target_type, target_id)
);
create index if not exists talent_reports_open_idx on public.talent_reports (status, created_at);
create table if not exists public.talent_moderation (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles (id) on delete set null,
  target_type text not null,
  target_id uuid not null,
  action text not null,
  reason text,
  created_at timestamptz not null default now()
);

-- ---------- Helpers ----------
create or replace function public.is_moderator()
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_role() = 'developer'
$$;
-- true when either person has blocked the other
create or replace function public.talent_blocked(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_a is not null and p_b is not null and exists (
    select 1 from public.talent_blocks where (blocker_id = p_a and blocked_id = p_b) or (blocker_id = p_b and blocked_id = p_a))
$$;
create or replace function public.can_see_post(p_post uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.talent_posts p where p.id = p_post and (
    p.user_id = auth.uid() or public.is_moderator()
    or (p.status = 'approved' and not public.talent_blocked(auth.uid(), p.user_id))))
$$;

-- ---------- New posts: forced to pending + upload limits ----------
create or replace function public.talent_before_post()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.talent_profiles where user_id = new.user_id) then
      raise exception 'Choose a username before posting.';
    end if;
    if new.storage_path not like new.user_id::text || '/%' or (new.poster_path is not null and new.poster_path not like new.user_id::text || '/%') then
      raise exception 'Files must be in your own folder.';
    end if;
    if (select count(*) from public.talent_posts where user_id = new.user_id and created_at > now() - interval '24 hours') >= 5 then
      raise exception 'You can post up to 5 times a day. Try again tomorrow.';
    end if;
    if (select count(*) from public.talent_posts where user_id = new.user_id and status = 'pending') >= 10 then
      raise exception 'You have 10 posts waiting for review. Please wait for them to be checked.';
    end if;
    new.status := 'pending'; new.status_reason := null; new.approved_at := null;
    new.like_count := 0; new.comment_count := 0; new.share_count := 0;
  end if;
  return new;
end $$;
drop trigger if exists trg_talent_before_post on public.talent_posts;
create trigger trg_talent_before_post before insert on public.talent_posts for each row execute function public.talent_before_post();

-- ---------- Counters (kept by the database only) ----------
create or replace function public.talent_count_likes()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then update public.talent_posts set like_count = like_count + 1 where id = new.post_id;
  else update public.talent_posts set like_count = greatest(0, like_count - 1) where id = old.post_id; end if;
  return null;
end $$;
drop trigger if exists trg_talent_count_likes on public.talent_likes;
create trigger trg_talent_count_likes after insert or delete on public.talent_likes for each row execute function public.talent_count_likes();

create or replace function public.talent_count_comments()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and new.status = 'visible' then update public.talent_posts set comment_count = comment_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' and old.status = 'visible' then update public.talent_posts set comment_count = greatest(0, comment_count - 1) where id = old.post_id;
  elsif tg_op = 'UPDATE' and old.status = 'visible' and new.status = 'removed' then update public.talent_posts set comment_count = greatest(0, comment_count - 1) where id = new.post_id;
  end if;
  return null;
end $$;
drop trigger if exists trg_talent_count_comments on public.talent_comments;
create trigger trg_talent_count_comments after insert or update or delete on public.talent_comments for each row execute function public.talent_count_comments();

create or replace function public.talent_count_shares()
returns trigger language plpgsql security definer set search_path = public as $$
begin update public.talent_posts set share_count = share_count + 1 where id = new.post_id; return null; end $$;
drop trigger if exists trg_talent_count_shares on public.talent_shares;
create trigger trg_talent_count_shares after insert on public.talent_shares for each row execute function public.talent_count_shares();

-- ---------- Row level security ----------
alter table public.talent_profiles enable row level security;
alter table public.talent_posts enable row level security;
alter table public.talent_likes enable row level security;
alter table public.talent_saves enable row level security;
alter table public.talent_shares enable row level security;
alter table public.talent_comments enable row level security;
alter table public.talent_follows enable row level security;
alter table public.talent_blocks enable row level security;
alter table public.talent_reports enable row level security;
alter table public.talent_moderation enable row level security;

drop policy if exists "tp: signed-in read" on public.talent_profiles;
create policy "tp: signed-in read" on public.talent_profiles for select using (auth.uid() is not null);
drop policy if exists "tp: own insert" on public.talent_profiles;
create policy "tp: own insert" on public.talent_profiles for insert with check (user_id = auth.uid());
drop policy if exists "tp: own update" on public.talent_profiles;
create policy "tp: own update" on public.talent_profiles for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "posts: visible" on public.talent_posts;
create policy "posts: visible" on public.talent_posts for select
  using (user_id = auth.uid() or public.is_moderator() or (auth.uid() is not null and status = 'approved' and not public.talent_blocked(auth.uid(), user_id)));
drop policy if exists "posts: own insert" on public.talent_posts;
create policy "posts: own insert" on public.talent_posts for insert with check (user_id = auth.uid() and public.current_role() = 'customer');
-- No update/delete policies: changes go through delete_my_post() / moderate_post().

drop policy if exists "likes: read" on public.talent_likes;
create policy "likes: read" on public.talent_likes for select using (user_id = auth.uid());
drop policy if exists "likes: own add" on public.talent_likes;
create policy "likes: own add" on public.talent_likes for insert with check (user_id = auth.uid() and public.can_see_post(post_id));
drop policy if exists "likes: own remove" on public.talent_likes;
create policy "likes: own remove" on public.talent_likes for delete using (user_id = auth.uid());
drop policy if exists "saves: own" on public.talent_saves;
create policy "saves: own" on public.talent_saves for select using (user_id = auth.uid());
drop policy if exists "saves: own add" on public.talent_saves;
create policy "saves: own add" on public.talent_saves for insert with check (user_id = auth.uid() and public.can_see_post(post_id));
drop policy if exists "saves: own remove" on public.talent_saves;
create policy "saves: own remove" on public.talent_saves for delete using (user_id = auth.uid());
drop policy if exists "shares: own add" on public.talent_shares;
create policy "shares: own add" on public.talent_shares for insert with check (user_id = auth.uid() and public.can_see_post(post_id));

drop policy if exists "comments: read" on public.talent_comments;
create policy "comments: read" on public.talent_comments for select
  using (public.is_moderator() or (status = 'visible' and public.can_see_post(post_id) and not public.talent_blocked(auth.uid(), user_id)));
-- Comments only on approved posts you can see; replies one level deep, on the same post.
create or replace function public.talent_comment_ok(p_post uuid, p_parent uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.can_see_post(p_post)
     and exists (select 1 from public.talent_posts p where p.id = p_post and p.status = 'approved')
     and (p_parent is null or exists (select 1 from public.talent_comments c where c.id = p_parent and c.post_id = p_post and c.parent_id is null and c.status = 'visible'))
$$;
drop policy if exists "comments: own add" on public.talent_comments;
create policy "comments: own add" on public.talent_comments for insert
  with check (user_id = auth.uid() and status = 'visible' and public.talent_comment_ok(post_id, parent_id));
drop policy if exists "comments: own delete" on public.talent_comments;
create policy "comments: own delete" on public.talent_comments for delete using (user_id = auth.uid());

drop policy if exists "follows: read" on public.talent_follows;
create policy "follows: read" on public.talent_follows for select using (auth.uid() is not null);
drop policy if exists "follows: own add" on public.talent_follows;
create policy "follows: own add" on public.talent_follows for insert with check (follower_id = auth.uid() and not public.talent_blocked(follower_id, followee_id));
drop policy if exists "follows: own remove" on public.talent_follows;
create policy "follows: own remove" on public.talent_follows for delete using (follower_id = auth.uid());

drop policy if exists "blocks: own" on public.talent_blocks;
create policy "blocks: own" on public.talent_blocks for select using (blocker_id = auth.uid());
drop policy if exists "blocks: own add" on public.talent_blocks;
create policy "blocks: own add" on public.talent_blocks for insert with check (blocker_id = auth.uid());
drop policy if exists "blocks: own remove" on public.talent_blocks;
create policy "blocks: own remove" on public.talent_blocks for delete using (blocker_id = auth.uid());

drop policy if exists "reports: own or moderator" on public.talent_reports;
create policy "reports: own or moderator" on public.talent_reports for select using (reporter_id = auth.uid() or public.is_moderator());
drop policy if exists "reports: own add" on public.talent_reports;
create policy "reports: own add" on public.talent_reports for insert with check (reporter_id = auth.uid() and status = 'open');
drop policy if exists "moderation: moderator reads" on public.talent_moderation;
create policy "moderation: moderator reads" on public.talent_moderation for select using (public.is_moderator());

-- Blocking also removes follows both ways.
create or replace function public.talent_after_block()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.talent_follows where (follower_id = new.blocker_id and followee_id = new.blocked_id) or (follower_id = new.blocked_id and followee_id = new.blocker_id);
  return null;
end $$;
drop trigger if exists trg_talent_after_block on public.talent_blocks;
create trigger trg_talent_after_block after insert on public.talent_blocks for each row execute function public.talent_after_block();

-- ---------- Owner delete / moderation ----------
-- Returns the file paths so the caller can delete them from storage.
create or replace function public.delete_my_post(p_post uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.talent_posts;
begin
  select * into p from public.talent_posts where id = p_post and user_id = auth.uid();
  if not found then raise exception 'Post not found.'; end if;
  delete from public.talent_posts where id = p_post;
  return jsonb_build_object('files', jsonb_build_array(p.storage_path) || case when p.poster_path is not null then jsonb_build_array(p.poster_path) else '[]'::jsonb end);
end $$;

create or replace function public.moderate_post(p_post uuid, p_action text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.talent_posts;
begin
  if not public.is_moderator() then raise exception 'Only the moderator can do this.'; end if;
  select * into p from public.talent_posts where id = p_post for update;
  if not found then raise exception 'Post not found.'; end if;
  if p_action not in ('approve', 'reject', 'remove') then raise exception 'Unknown action.'; end if;
  if p_action <> 'approve' and coalesce(char_length(trim(p_reason)), 0) < 3 then raise exception 'Please give a reason.'; end if;
  update public.talent_posts
     set status = case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else 'removed' end,
         status_reason = case when p_action = 'approve' then null else left(trim(p_reason), 200) end,
         approved_at = case when p_action = 'approve' then now() else approved_at end
   where id = p_post;
  insert into public.talent_moderation (actor_id, target_type, target_id, action, reason) values (auth.uid(), 'post', p_post, p_action, p_reason);
  update public.talent_reports set status = 'actioned', handled_by = auth.uid(), handled_at = now()
   where target_type = 'post' and target_id = p_post and status = 'open' and p_action <> 'approve';
  insert into public.notifications (user_id, message, type)
  values (p.user_id, case p_action
      when 'approve' then 'Your Campus Talent post is now live.'
      when 'reject' then 'Your Campus Talent post was not approved: ' || left(trim(p_reason), 150)
      else 'Your Campus Talent post was removed: ' || left(trim(p_reason), 150) end, 'talent');
  -- removed/rejected files are deleted from storage by the moderator's app using these paths
  return jsonb_build_object('files', case when p_action = 'approve' then '[]'::jsonb
    else jsonb_build_array(p.storage_path) || case when p.poster_path is not null then jsonb_build_array(p.poster_path) else '[]'::jsonb end end);
end $$;

create or replace function public.moderate_comment(p_comment uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_moderator() then raise exception 'Only the moderator can do this.'; end if;
  update public.talent_comments set status = 'removed' where id = p_comment;
  insert into public.talent_moderation (actor_id, target_type, target_id, action, reason) values (auth.uid(), 'comment', p_comment, 'remove', p_reason);
  update public.talent_reports set status = 'actioned', handled_by = auth.uid(), handled_at = now() where target_type = 'comment' and target_id = p_comment and status = 'open';
end $$;

create or replace function public.dismiss_report(p_report uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_moderator() then raise exception 'Only the moderator can do this.'; end if;
  update public.talent_reports set status = 'dismissed', handled_by = auth.uid(), handled_at = now() where id = p_report;
  insert into public.talent_moderation (actor_id, target_type, target_id, action) values (auth.uid(), 'report', p_report, 'dismiss');
end $$;

-- ---------- Feeds & profiles (paged; blocked people never appear) ----------
create or replace function public.talent_feed(p_mode text, p_offset int default 0, p_limit int default 10)
returns table (id uuid, user_id uuid, username text, kind text, storage_path text, poster_path text, caption text,
               duration_seconds numeric, like_count int, comment_count int, share_count int, created_at timestamptz,
               liked boolean, saved boolean, following boolean)
language sql stable security definer set search_path = public as $$
  select p.id, p.user_id, tp.username, p.kind, p.storage_path, p.poster_path, p.caption, p.duration_seconds,
         p.like_count, p.comment_count, p.share_count, p.created_at,
         exists (select 1 from public.talent_likes l where l.post_id = p.id and l.user_id = auth.uid()),
         exists (select 1 from public.talent_saves s where s.post_id = p.id and s.user_id = auth.uid()),
         exists (select 1 from public.talent_follows f where f.follower_id = auth.uid() and f.followee_id = p.user_id)
  from public.talent_posts p join public.talent_profiles tp on tp.user_id = p.user_id
  where auth.uid() is not null and p.status = 'approved' and not public.talent_blocked(auth.uid(), p.user_id)
    and (p_mode <> 'following' or exists (select 1 from public.talent_follows f where f.follower_id = auth.uid() and f.followee_id = p.user_id))
    and (p_mode <> 'trending' or p.approved_at > now() - interval '7 days')
    and (p_mode <> 'saved' or exists (select 1 from public.talent_saves s where s.post_id = p.id and s.user_id = auth.uid()))
  order by
    case when p_mode = 'trending' then p.like_count + 2 * p.comment_count + 3 * p.share_count end desc nulls last,
    -- For You: recent posts, nudged up by engagement (no personal tracking)
    case when p_mode = 'for_you' then extract(epoch from p.approved_at) / 3600 + ln(1 + p.like_count + 2 * p.comment_count) * 6 end desc nulls last,
    p.approved_at desc
  offset greatest(0, p_offset) limit least(greatest(1, p_limit), 20)
$$;

create or replace function public.talent_profile(p_username text)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when tp.user_id is null or public.talent_blocked(auth.uid(), tp.user_id) then null else jsonb_build_object(
    'user_id', tp.user_id, 'username', tp.username, 'bio', tp.bio, 'is_me', tp.user_id = auth.uid(),
    'followers', (select count(*) from public.talent_follows where followee_id = tp.user_id),
    'following', (select count(*) from public.talent_follows where follower_id = tp.user_id),
    'total_likes', (select coalesce(sum(like_count), 0) from public.talent_posts where user_id = tp.user_id and status = 'approved'),
    'posts', (select count(*) from public.talent_posts where user_id = tp.user_id and status = 'approved'),
    'i_follow', exists (select 1 from public.talent_follows where follower_id = auth.uid() and followee_id = tp.user_id)) end
  from public.talent_profiles tp where lower(tp.username) = lower(btrim(p_username)) and auth.uid() is not null
$$;

revoke all on function public.delete_my_post(uuid) from public, anon;
revoke all on function public.moderate_post(uuid, text, text) from public, anon;
revoke all on function public.moderate_comment(uuid, text) from public, anon;
revoke all on function public.dismiss_report(uuid) from public, anon;
revoke all on function public.talent_feed(text, int, int) from public, anon;
revoke all on function public.talent_profile(text) from public, anon;
grant execute on function public.delete_my_post(uuid) to authenticated;
grant execute on function public.moderate_post(uuid, text, text) to authenticated;
grant execute on function public.moderate_comment(uuid, text) to authenticated;
grant execute on function public.dismiss_report(uuid) to authenticated;
grant execute on function public.talent_feed(text, int, int) to authenticated;
grant execute on function public.talent_profile(text) to authenticated;
