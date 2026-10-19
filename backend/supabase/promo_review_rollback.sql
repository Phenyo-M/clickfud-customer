-- Rollback of promo_review.sql. Codes not yet approved are switched off
-- first, so they never reach customers once the review is gone. The columns
-- stay (harmless); re-run engagement_deals.sql afterwards for the old promo_block_reason().
update public.promotions set active = false where review_status <> 'approved' and active;
drop trigger if exists trg_promotions_review_guard on public.promotions;
drop function if exists public.promotions_review_guard();
drop function if exists public.dev_review_promo(uuid, text, text);
drop policy if exists "promos select approved" on public.promotions;
drop policy if exists "promos select all" on public.promotions;
create policy "promos select all" on public.promotions for select using (true);
alter table public.promotions alter column review_status set default 'approved';
