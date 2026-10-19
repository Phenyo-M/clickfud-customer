-- ============================================================
-- ClickFood: archive homepage placements and home page images (2026-10-12)
-- Archived = kept (can be restored) but never shown to customers.
-- Only the developer can archive, restore, edit or delete (existing
-- developer update/delete policies). Safe to run more than once.
-- Rollback: promo_archive_rollback.sql
-- ============================================================
alter table public.store_promotions add column if not exists archived_at timestamptz;
alter table public.home_page_media add column if not exists archived_at timestamptz;

drop policy if exists "store_promotions select" on public.store_promotions;
create policy "store_promotions select" on public.store_promotions for select using (
  ((status = 'approved') and (active = true) and archived_at is null
    and ((start_date is null) or (start_date <= now())) and ((end_date is null) or (end_date > now())))
  or exists (select 1 from public.stores s where s.id = store_promotions.store_id and s.manager_id = auth.uid())
  or public."current_role"() = 'developer');

drop policy if exists "home_page_media select" on public.home_page_media;
create policy "home_page_media select" on public.home_page_media for select
  using (archived_at is null or public."current_role"() = 'developer');
