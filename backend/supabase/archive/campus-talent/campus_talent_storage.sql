-- =========================================================================
-- ClickFood — Campus Talent file storage (2026-10-01). Run after campus_talent.sql.
--
-- Private bucket "talent": nothing is public. The app gets short-lived signed
-- links, and Storage only signs a link when these rules allow reading:
--   * your own files (your folder is your user id), or
--   * files of an APPROVED post by someone you haven't blocked (and who
--     hasn't blocked you), or
--   * the moderator (developer).
-- Uploads: students only, only into their own folder, 50 MB max, video/photo types only.
-- Safe to run more than once.
-- =========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('talent', 'talent', false, 52428800,
        array['video/mp4', 'video/webm', 'video/quicktime', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "talent: upload own folder" on storage.objects;
create policy "talent: upload own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'talent' and (storage.foldername(name))[1] = auth.uid()::text and public.current_role() = 'customer');

drop policy if exists "talent: read allowed" on storage.objects;
create policy "talent: read allowed" on storage.objects for select to authenticated
  using (bucket_id = 'talent' and (
    (storage.foldername(name))[1] = auth.uid()::text
    or public.is_moderator()
    or exists (select 1 from public.talent_posts p
               where (p.storage_path = name or p.poster_path = name) and p.status = 'approved'
                 and not public.talent_blocked(auth.uid(), p.user_id))));

drop policy if exists "talent: delete own or moderator" on storage.objects;
create policy "talent: delete own or moderator" on storage.objects for delete to authenticated
  using (bucket_id = 'talent' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_moderator()));
