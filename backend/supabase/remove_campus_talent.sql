-- =========================================================================
-- Remove Campus Talent (2026-10-02)
--
-- Drops every database object that existed only for Campus Talent: its 11
-- tables (with their triggers, indexes and row-level security policies), its
-- 17 functions and the 3 access rules on the "talent" storage bucket.
-- Nothing shared is touched: profiles, notifications and storage.objects
-- stay as they are. No CASCADE is used, so if anything outside Campus
-- Talent ever depended on one of these objects the drop stops with an error
-- instead of silently removing it.
--
-- The 'talent' bucket and its files are removed through the Storage API
-- (Supabase blocks any SQL delete on its storage tables), not here.
--
-- The original setup files are in supabase/archive/campus-talent/.
-- Safe to run more than once.
-- =========================================================================

-- ---------- storage access rules ----------
drop policy if exists "talent: upload own folder" on storage.objects;
drop policy if exists "talent: read allowed" on storage.objects;
drop policy if exists "talent: delete own or moderator" on storage.objects;

-- ---------- tables (their triggers, indexes and policies go with them) ----------
drop table if exists
  public.talent_views, public.talent_shares, public.talent_saves, public.talent_likes,
  public.talent_comments, public.talent_reports, public.talent_moderation,
  public.talent_follows, public.talent_blocks, public.talent_posts, public.talent_profiles;

-- ---------- functions ----------
drop function if exists public.talent_feed(text, integer, integer);
drop function if exists public.talent_profile(text);
drop function if exists public.record_talent_view(uuid);
drop function if exists public.delete_my_post(uuid);
drop function if exists public.moderate_post(uuid, text, text);
drop function if exists public.moderate_comment(uuid, text);
drop function if exists public.dismiss_report(uuid);
drop function if exists public.can_see_post(uuid);
drop function if exists public.talent_comment_ok(uuid, uuid);
drop function if exists public.talent_blocked(uuid, uuid);
drop function if exists public.is_moderator();
drop function if exists public.talent_before_post();
drop function if exists public.talent_count_likes();
drop function if exists public.talent_count_comments();
drop function if exists public.talent_count_shares();
drop function if exists public.talent_after_block();
drop function if exists public.talent_zero_views();

