-- Undo promo_archive.sql: archived items become visible again (columns kept).
begin;
drop policy if exists "store_promotions select" on public.store_promotions;
create policy "store_promotions select" on public.store_promotions for select using (
  ((status = 'approved') and (active = true)
    and ((start_date is null) or (start_date <= now())) and ((end_date is null) or (end_date > now())))
  or exists (select 1 from public.stores s where s.id = store_promotions.store_id and s.manager_id = auth.uid())
  or public."current_role"() = 'developer');
drop policy if exists "home_page_media select" on public.home_page_media;
create policy "home_page_media select" on public.home_page_media for select using (true);
commit;
