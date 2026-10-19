-- =========================================================================
-- Campus Talent: free-form usernames
-- Students can pick any username (spaces, capitals, emoji, any language).
-- Only limits: 1 to 30 characters after trimming, no invisible control
-- characters, and unique ignoring capital letters ("Lebo" and "lebo" clash).
-- Safe to run more than once.
-- =========================================================================

alter table public.talent_profiles drop constraint if exists talent_profiles_username_check;
alter table public.talent_profiles add constraint talent_profiles_username_check
  check (username = btrim(username) and char_length(username) between 1 and 30 and username !~ '[[:cntrl:]]');

drop index if exists public.talent_profiles_username_uniq;
create unique index if not exists talent_profiles_username_lower_uniq on public.talent_profiles (lower(username));

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
