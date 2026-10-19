-- =========================================================================
-- ClickFood: shop polls are reviewed by the developer before students see
-- them (2026-10-18). Run after engagement_deals.sql. Safe to run more than once.
--
--  * polls.status: pending_review / published / rejected. A poll made by a
--    shop manager is ALWAYS saved as pending_review (a trigger sets it, so
--    the app cannot skip the review). Campus polls made by the developer
--    are published straight away, as before.
--  * Students only read published polls; vote_poll refuses anything else.
--    The manager still sees their own polls (and the review result).
--  * dev_review_poll(): developer only. Approve publishes the poll and
--    starts it then, for the full time the manager chose. Reject needs a
--    reason, which the manager sees.
--  * After saving, a manager can only end or delete their poll: the
--    question and options can't be changed once students may have voted.
-- =========================================================================

alter table public.polls add column if not exists status text not null default 'published';
alter table public.polls alter column status set default 'pending_review';
do $$ begin
  alter table public.polls add constraint polls_status_valid check (status in ('pending_review', 'published', 'rejected'));
exception when duplicate_object then null; end $$;
alter table public.polls add column if not exists reviewed_by uuid references public.profiles (id) on delete set null;
alter table public.polls add column if not exists reviewed_at timestamptz;
alter table public.polls add column if not exists review_note text check (review_note is null or char_length(review_note) <= 300);
create index if not exists polls_pending_idx on public.polls (created_at) where status = 'pending_review';

-- New polls: only the developer's campus polls skip the review. On change:
-- the creator may only end the poll (the developer reviews through dev_review_poll).
create or replace function public.polls_review_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if public.current_role() = 'developer' and new.store_id is null then
      new.status := 'published';
    else
      new.status := 'pending_review';
    end if;
    new.reviewed_by := null; new.reviewed_at := null; new.review_note := null;
    return new;
  end if;
  if auth.uid() is null or public.current_role() = 'developer' then return new; end if;
  if new.status is distinct from old.status or new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at
     or new.review_note is distinct from old.review_note or new.question is distinct from old.question or new.options is distinct from old.options
     or new.store_id is distinct from old.store_id or new.created_by is distinct from old.created_by or new.starts_at is distinct from old.starts_at then
    raise exception 'A poll can only be ended after it is saved.';
  end if;
  if new.ends_at > old.ends_at then raise exception 'A poll can only be ended after it is saved.'; end if;
  return new;
end $$;
drop trigger if exists trg_polls_review_guard on public.polls;
create trigger trg_polls_review_guard before insert or update on public.polls for each row execute function public.polls_review_guard();

-- Who sees a poll: everyone once it is published; before that only its
-- shop's manager, its creator and the developer.
drop policy if exists "polls: everyone reads" on public.polls;
drop policy if exists "polls: published or own" on public.polls;
create policy "polls: published or own" on public.polls for select using (
  status = 'published' or created_by = auth.uid() or public.current_role() = 'developer'
  or (store_id is not null and public.current_role() = 'manager' and store_id = public.current_store_id()));

create or replace function public.vote_poll(p_poll uuid, p_option int)
returns void language plpgsql security definer set search_path = public as $$
declare p public.polls;
begin
  if auth.uid() is null then raise exception 'Please sign in to vote.'; end if;
  select * into p from public.polls where id = p_poll;
  if not found or p.status <> 'published' then raise exception 'Poll not found.'; end if;
  if now() < p.starts_at or now() >= p.ends_at then raise exception 'This poll is closed.'; end if;
  if p_option is null or p_option < 0 or p_option >= cardinality(p.options) then raise exception 'Please choose an option.'; end if;
  insert into public.poll_votes (poll_id, user_id, option_index) values (p_poll, auth.uid(), p_option)
  on conflict (poll_id, user_id) do nothing;
  if not found then raise exception 'You have already voted in this poll.'; end if;
end $$;
revoke all on function public.vote_poll(uuid, int) from public, anon;
grant execute on function public.vote_poll(uuid, int) to authenticated;

-- Results (counts only): of published polls, shown to people who voted, to
-- the poll's creator, or once it has closed. The creator and developer always.
create or replace function public.poll_results(p_poll uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when p.created_by = auth.uid() or public.current_role() = 'developer'
                   or (p.status = 'published' and (now() >= p.ends_at or exists (select 1 from public.poll_votes v where v.poll_id = p.id and v.user_id = auth.uid())))
         then jsonb_build_object('total', (select count(*) from public.poll_votes v where v.poll_id = p.id),
                                 'counts', (select jsonb_agg((select count(*) from public.poll_votes v where v.poll_id = p.id and v.option_index = i - 1) order by i)
                                            from generate_series(1, cardinality(p.options)) i),
                                 'mine', (select option_index from public.poll_votes v where v.poll_id = p.id and v.user_id = auth.uid()))
         else null end
  from public.polls p where p.id = p_poll
$$;
grant execute on function public.poll_results(uuid) to authenticated;

-- The developer approves (publishes) or rejects a shop's poll.
create or replace function public.dev_review_poll(p_poll uuid, p_action text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.polls; v_len interval; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if auth.uid() is null or public.current_role() <> 'developer' then return jsonb_build_object('ok', false, 'error', 'Only the developer can review polls.'); end if;
  select * into p from public.polls where id = p_poll for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Poll not found.'); end if;
  if p.status <> 'pending_review' then return jsonb_build_object('ok', false, 'error', 'This poll has already been reviewed.'); end if;
  if p_action = 'approve' then
    v_len := greatest(p.ends_at - p.starts_at, interval '1 day');
    update public.polls set status = 'published', starts_at = now(), ends_at = now() + v_len,
           reviewed_by = auth.uid(), reviewed_at = now(), review_note = null where id = p.id;
  elsif p_action = 'reject' then
    if v_note is null or char_length(v_note) < 3 then return jsonb_build_object('ok', false, 'error', 'Please give the shop a reason.'); end if;
    update public.polls set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_note = left(v_note, 300) where id = p.id;
  else
    return jsonb_build_object('ok', false, 'error', 'Unknown action.');
  end if;
  return jsonb_build_object('ok', true, 'status', case when p_action = 'approve' then 'published' else 'rejected' end);
end $$;
revoke all on function public.dev_review_poll(uuid, text, text) from public, anon;
grant execute on function public.dev_review_poll(uuid, text, text) to authenticated;
