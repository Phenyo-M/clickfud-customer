-- Rollback of poll_review.sql. Polls not yet published are ended first, so
-- they never reach students once the review is gone. The columns stay
-- (harmless); re-run engagement_deals.sql afterwards for the old functions.
update public.polls set ends_at = now() where status <> 'published' and ends_at > now();
drop trigger if exists trg_polls_review_guard on public.polls;
drop function if exists public.polls_review_guard();
drop function if exists public.dev_review_poll(uuid, text, text);
drop policy if exists "polls: published or own" on public.polls;
drop policy if exists "polls: everyone reads" on public.polls;
create policy "polls: everyone reads" on public.polls for select using (true);
alter table public.polls alter column status set default 'published';
