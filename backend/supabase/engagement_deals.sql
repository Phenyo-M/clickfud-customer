-- =========================================================================
-- ClickFood — Phase 6a: Campus Deals, campaigns, trending, awards, polls (2026-10-01)
-- Run after security_audit.sql.
--
--  * promotions (existing promo codes) gain deal settings: public title and
--    terms, start date/time, daily hours, minimum order, deal tags (lunch /
--    exam / today), "show in Campus Deals", and an optional campaign.
--    Enforced on the server for cash orders (trigger) and before card
--    payment (promo_block_reason, called by paystack-initialize /
--    paystack-charge-saved). A paid order is never changed afterwards.
--  * FIX: usage limits were never counted (the app tried to update
--    used_count itself, which customers aren't allowed to do). The database
--    now counts each order that uses a code, gives the use back if the order
--    is cancelled, and refuses a cash order once the limit is reached.
--  * campaigns — Orientation Week, Exam Season, Sports Week, End of Semester;
--    created by the platform admin (developer), with start and end dates.
--  * campus_trending(days) / weekly_awards() — rankings from real valid
--    orders only, no customer details; empty when there isn't enough data.
--  * polls + poll_votes — managers (for their shop) or the developer
--    (campus-wide) ask; each account votes once; results are counts only.
-- Safe to run more than once.
-- =========================================================================

-- ---------- Campaigns ----------
create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 60),
  kind text not null check (kind in ('orientation', 'exams', 'sports', 'end_of_semester', 'other')),
  tagline text check (tagline is null or char_length(tagline) <= 120),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
alter table public.campaigns enable row level security;
drop policy if exists "campaigns: everyone reads" on public.campaigns;
create policy "campaigns: everyone reads" on public.campaigns for select using (true);
drop policy if exists "campaigns: developer writes" on public.campaigns;
create policy "campaigns: developer writes" on public.campaigns for all
  using (public.current_role() = 'developer') with check (public.current_role() = 'developer');

-- ---------- Deal settings on promo codes ----------
alter table public.promotions add column if not exists title text check (title is null or char_length(title) <= 60);
alter table public.promotions add column if not exists terms text check (terms is null or char_length(terms) <= 300);
alter table public.promotions add column if not exists starts_at timestamptz;
alter table public.promotions add column if not exists daily_start time;
alter table public.promotions add column if not exists daily_end time;
alter table public.promotions add column if not exists min_order numeric(10,2) check (min_order is null or min_order >= 0);
alter table public.promotions add column if not exists deal_tags text[] not null default '{}';
alter table public.promotions add column if not exists is_public boolean not null default false;
alter table public.promotions add column if not exists campaign_id uuid references public.campaigns (id) on delete set null;
do $$ begin
  alter table public.promotions add constraint promotions_deal_tags_valid check (deal_tags <@ array['lunch', 'exam', 'today']::text[]);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.promotions add constraint promotions_daily_window_valid check ((daily_start is null) = (daily_end is null) and (daily_start is null or daily_start < daily_end));
exception when duplicate_object then null; end $$;

-- Why a code can't be used right now on an order of this size (null = it can).
create or replace function public.promo_block_reason(p_code text, p_order_subtotal numeric)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  p public.promotions;
  v_local timestamp := now() at time zone 'Africa/Johannesburg';
begin
  if p_code is null then return null; end if;
  select * into p from public.promotions where code = upper(trim(p_code));
  if not found or not p.active then return 'This promo code is not valid.'; end if;
  if p.starts_at is not null and p.starts_at > now() then
    return 'This deal starts on ' || to_char(p.starts_at at time zone 'Africa/Johannesburg', 'DD Mon HH24:MI') || '.';
  end if;
  if p.expires_at is not null and p.expires_at < now() then return 'This promo code has expired.'; end if;
  if p.usage_limit is not null and p.used_count >= p.usage_limit then return 'This deal has been fully claimed.'; end if;
  if p.daily_start is not null and (v_local::time < p.daily_start or v_local::time >= p.daily_end) then
    return 'This deal is only on between ' || to_char(p.daily_start, 'HH24:MI') || ' and ' || to_char(p.daily_end, 'HH24:MI') || '.';
  end if;
  if p.min_order is not null and coalesce(p_order_subtotal, 0) < p.min_order then
    return 'This deal needs an order of at least R' || to_char(p.min_order, 'FM999990.00') || '.';
  end if;
  return null;
end $$;
grant execute on function public.promo_block_reason(text, numeric) to anon, authenticated, service_role;

-- Cash orders (placed by the customer): drop a code that isn't allowed right
-- now. Runs after validate_order_pricing (trigger names sort that way).
create or replace function public.enforce_deal_rules()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or new.promo_code is null then return new; end if;   -- paid card orders are never changed
  if public.promo_block_reason(new.promo_code, new.subtotal) is not null then
    new.promo_code := null;
    new.discount := 0;
    new.total := greatest(0, new.subtotal + coalesce(new.delivery_fee, 0));
  end if;
  return new;
end $$;
drop trigger if exists trg_zz_enforce_deal_rules on public.orders;
create trigger trg_zz_enforce_deal_rules before insert on public.orders for each row execute function public.enforce_deal_rules();

-- Count uses (and give them back when an order is cancelled).
create or replace function public.count_promo_use()
returns trigger language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if tg_op = 'INSERT' then
    if new.promo_code is null or new.status = 'cancelled' then return new; end if;
    update public.promotions set used_count = used_count + 1
     where code = new.promo_code and (auth.uid() is null or usage_limit is null or used_count < usage_limit);
    get diagnostics n = row_count;
    if n = 0 and auth.uid() is not null then
      raise exception 'This deal has just been fully claimed. Please remove the code and try again.';
    end if;
  elsif new.status = 'cancelled' and old.status is distinct from 'cancelled' and new.promo_code is not null then
    update public.promotions set used_count = greatest(0, used_count - 1) where code = new.promo_code;
  end if;
  return new;
end $$;
drop trigger if exists trg_count_promo_use on public.orders;
create trigger trg_count_promo_use after insert or update of status on public.orders for each row execute function public.count_promo_use();

-- ---------- Trending / rankings (real valid orders, no personal data) ----------
create or replace function public.campus_trending(p_days int default 7)
returns table (menu_item_id uuid, name text, store_id uuid, store_name text, units bigint, orders bigint)
language sql stable security definer set search_path = public as $$
  with s as (
    select o.id, o.store_id, o.items from public.orders o
    where public.is_valid_sale(o.status, o.payment_status) and o.created_at >= now() - make_interval(days => greatest(1, least(p_days, 31)))
  ), enough as (select count(*) >= 5 as ok from s)
  select mi.id, mi.name, st.id, st.name, sum(greatest(1, coalesce((e->>'qty')::int, 1)))::bigint, count(distinct s.id)::bigint
  from s cross join lateral jsonb_array_elements(coalesce(s.items, '[]'::jsonb)) e
  join public.menu_items mi on mi.id::text = e->>'menuItemId' and mi.status = 'approved'
  join public.stores st on st.id = mi.store_id and st.status = 'approved' and st.is_published
  where (select ok from enough) and not coalesce((e->>'isAddon')::boolean, false)
  group by mi.id, mi.name, st.id, st.name
  order by 5 desc, 6 desc, mi.name
  limit 10
$$;
grant execute on function public.campus_trending(int) to anon, authenticated;

-- Last full week (Monday to Sunday, South African time). Each award says how it was decided.
create or replace function public.weekly_awards()
returns jsonb
language sql stable security definer set search_path = public as $$
  with wk as (
    select (date_trunc('week', now() at time zone 'Africa/Johannesburg') - interval '7 days') as f,
           date_trunc('week', now() at time zone 'Africa/Johannesburg') as t
  ), s as (
    select o.* from public.orders o, wk
    where public.is_valid_sale(o.status, o.payment_status) and (o.created_at at time zone 'Africa/Johannesburg') >= wk.f and (o.created_at at time zone 'Africa/Johannesburg') < wk.t
  ), meal as (
    select mi.name, st.name as store, sum(greatest(1, coalesce((e->>'qty')::int, 1)))::int as n
    from s cross join lateral jsonb_array_elements(s.items) e
    join public.menu_items mi on mi.id::text = e->>'menuItemId' join public.stores st on st.id = mi.store_id
    where not coalesce((e->>'isAddon')::boolean, false) group by 1, 2 order by 3 desc, 1 limit 1
  ), kitchen as (
    select st.name, count(*)::int as n from s join public.stores st on st.id = s.store_id group by 1 order by 2 desc, 1 limit 1
  ), deal as (
    select coalesce(p.title, p.code) as name, st.name as store, count(*)::int as n
    from s join public.promotions p on p.code = s.promo_code left join public.stores st on st.id = p.store_id
    group by 1, 2 order by 3 desc, 1 limit 1
  ), reviewed as (
    select st.name, count(*)::int as n from public.reviews r join public.stores st on st.id = r.store_id, wk
    where (r.created_at at time zone 'Africa/Johannesburg') >= wk.f and (r.created_at at time zone 'Africa/Johannesburg') < wk.t
    group by 1 order by 2 desc, 1 limit 1
  )
  select jsonb_build_object(
    'week_start', (select f::date from wk), 'week_end', (select (t - interval '1 day')::date from wk),
    'enough', (select count(*) >= 5 from s),
    'awards', jsonb_build_array(
      (select jsonb_build_object('title', 'Most ordered meal', 'winner', name, 'detail', store, 'measure', n || ' ordered', 'rule', 'Most portions in collected orders last week') from meal),
      (select jsonb_build_object('title', 'Most popular kitchen', 'winner', name, 'measure', n || ' orders', 'rule', 'Most collected orders last week') from kitchen),
      (select jsonb_build_object('title', 'Biggest student deal', 'winner', name, 'detail', store, 'measure', n || ' times used', 'rule', 'Deal used on the most orders last week') from deal),
      (select jsonb_build_object('title', 'Most reviewed kitchen', 'winner', name, 'measure', n || ' reviews', 'rule', 'Most student reviews written last week') from reviewed)
    ))
$$;
grant execute on function public.weekly_awards() to anon, authenticated;

-- ---------- Polls ----------
create table if not exists public.polls (
  id uuid primary key default gen_random_uuid(),
  question text not null check (char_length(question) between 5 and 140),
  options text[] not null check (cardinality(options) between 2 and 6),
  store_id uuid references public.stores (id) on delete cascade,      -- null = campus-wide (developer)
  created_by uuid references public.profiles (id) on delete set null,
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create table if not exists public.poll_votes (
  poll_id uuid not null references public.polls (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  option_index int not null check (option_index >= 0),
  created_at timestamptz not null default now(),
  primary key (poll_id, user_id)
);
alter table public.polls enable row level security;
alter table public.poll_votes enable row level security;
drop policy if exists "polls: everyone reads" on public.polls;
create policy "polls: everyone reads" on public.polls for select using (true);
drop policy if exists "polls: managers and developer create" on public.polls;
create policy "polls: managers and developer create" on public.polls for insert
  with check (created_by = auth.uid() and (
    (public.current_role() = 'manager' and store_id = public.current_store_id())
    or (public.current_role() = 'developer' and store_id is null)));
drop policy if exists "polls: owner ends" on public.polls;
create policy "polls: owner ends" on public.polls for update
  using (created_by = auth.uid()) with check (created_by = auth.uid());
drop policy if exists "polls: owner deletes" on public.polls;
create policy "polls: owner deletes" on public.polls for delete using (created_by = auth.uid());
drop policy if exists "votes: see own" on public.poll_votes;
create policy "votes: see own" on public.poll_votes for select using (user_id = auth.uid());
-- Votes are only cast through vote_poll() so the option and dates are checked.

create or replace function public.vote_poll(p_poll uuid, p_option int)
returns void language plpgsql security definer set search_path = public as $$
declare p public.polls;
begin
  if auth.uid() is null then raise exception 'Please sign in to vote.'; end if;
  select * into p from public.polls where id = p_poll;
  if not found then raise exception 'Poll not found.'; end if;
  if now() < p.starts_at or now() >= p.ends_at then raise exception 'This poll is closed.'; end if;
  if p_option is null or p_option < 0 or p_option >= cardinality(p.options) then raise exception 'Please choose an option.'; end if;
  insert into public.poll_votes (poll_id, user_id, option_index) values (p_poll, auth.uid(), p_option)
  on conflict (poll_id, user_id) do nothing;
  if not found then raise exception 'You have already voted in this poll.'; end if;
end $$;
revoke all on function public.vote_poll(uuid, int) from public, anon;
grant execute on function public.vote_poll(uuid, int) to authenticated;

-- Results (counts only): shown to people who voted, to the poll's creator, or once it has closed.
create or replace function public.poll_results(p_poll uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when exists (select 1 from public.poll_votes v where v.poll_id = p.id and v.user_id = auth.uid())
                   or p.created_by = auth.uid() or now() >= p.ends_at
         then jsonb_build_object('total', (select count(*) from public.poll_votes v where v.poll_id = p.id),
                                 'counts', (select jsonb_agg((select count(*) from public.poll_votes v where v.poll_id = p.id and v.option_index = i - 1) order by i)
                                            from generate_series(1, cardinality(p.options)) i),
                                 'mine', (select option_index from public.poll_votes v where v.poll_id = p.id and v.user_id = auth.uid()))
         else null end
  from public.polls p where p.id = p_poll
$$;
grant execute on function public.poll_results(uuid) to authenticated;
