-- ============================================================
-- CLICKFOOD, login protection (rate limiting for password sign-in)
--
-- Used ONLY by the secure-login Edge Function (service role). Replaces the
-- old login_attempts read-then-write lock (3 wrong passwords = 3 minute lock
-- for anyone typing that email), which parallel requests could bypass and
-- which let anyone lock a student out.
--
-- Layers, all checked in ONE transaction with row locks (no race):
--   pair     email + network: 5 wrong passwords in 15 min -> wait 30 s,
--            doubling per repeat (1, 2, 4, 8 min), never more than 15 min.
--   account  email from ANY network (attacks spread over many addresses):
--            10 in 15 min -> same waits, but NOT for a network this student
--            signed in from successfully before ("known pair"), so an
--            attacker can't lock a student out of their own phone/res Wi-Fi.
--   network  one address: 150 wrong passwords or 40 different accounts
--            failing in 10 min, AND at least half of its attempts failing,
--            marks it suspicious; then only NEW
--            (never-successful) email+network pairs are slowed to 30 a
--            minute. Campus Wi-Fi with thousands of students keeps working.
--   flood    one address: more than 3000 tries in 5 min from email+network
--            pairs that never signed in there (any result) -> wait. Known
--            students on that network are not counted or stopped.
--   parallel each pending login counts as a try until it finishes, so 50
--            requests sent at once can't get 50 guesses.
-- No permanent locks: every wait expires; the repeat counter resets after
-- 60 min without failures. All numbers live in login_limit_settings.
--
-- Privacy: emails and addresses never reach the database. The function
-- sends keyed hashes (HMAC with a server secret), 32 hex characters.
-- Counters expire within a day; metrics are per-minute counts only.
-- Clients (anon / customers / staff) cannot read or call any of it;
-- developers read aggregated metrics only.
-- Safe to run more than once.
-- ============================================================

create table if not exists public.login_limit_settings (
  id int primary key default 1 check (id = 1),
  pair_fail_limit int not null default 5,
  pair_window_min int not null default 15,
  account_fail_limit int not null default 10,
  account_window_min int not null default 15,
  ip_fail_limit int not null default 150,
  ip_window_min int not null default 10,
  ip_distinct_accounts int not null default 40,
  ip_unknown_per_min int not null default 30,
  ip_attempt_limit int not null default 3000,
  ip_attempt_window_min int not null default 5,
  base_wait_sec int not null default 30,
  max_wait_sec int not null default 900,
  escalation_reset_min int not null default 60,
  known_pair_days int not null default 30,
  alert_failures_per_min int not null default 200,
  inflight_timeout_sec int not null default 30,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
-- a network is only "suspicious" when MOST of its attempts fail (credential
-- stuffing); a busy campus with normal typos stays well below this
alter table public.login_limit_settings add column if not exists ip_min_fail_pct int not null default 50;
insert into public.login_limit_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.login_rl_state (
  key text primary key,                 -- 'p:' pair, 'a:' account, 'i:' network (hashes)
  fails int not null default 0,
  window_start timestamptz,
  last_fail_at timestamptz,
  strikes int not null default 0,
  blocked_until timestamptz,
  inflight int not null default 0,
  inflight_at timestamptz,
  attempts int not null default 0,      -- network rows: tries of any result
  attempts_start timestamptz,
  suspicious_until timestamptz,         -- network rows
  successes int not null default 0,     -- network rows: sign-ins in the same window as fails
  minute_start timestamptz,
  minute_count int not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.login_rl_state add column if not exists successes int not null default 0;
create index if not exists login_rl_state_updated on public.login_rl_state (updated_at);

create table if not exists public.login_ip_accounts (
  ip text not null, acct text not null, failed_at timestamptz not null default now(),
  primary key (ip, acct)
);
create index if not exists login_ip_accounts_time on public.login_ip_accounts (ip, failed_at);

create table if not exists public.login_known_pairs (
  pair text primary key, last_success_at timestamptz not null default now()
);

create table if not exists public.login_metrics (
  minute timestamptz not null, metric text not null, n bigint not null default 0,
  primary key (minute, metric)
);

alter table public.login_limit_settings enable row level security;
alter table public.login_rl_state enable row level security;
alter table public.login_ip_accounts enable row level security;
alter table public.login_known_pairs enable row level security;
alter table public.login_metrics enable row level security;
revoke all on public.login_limit_settings, public.login_rl_state, public.login_ip_accounts, public.login_known_pairs, public.login_metrics from public, anon, authenticated;
grant select on public.login_limit_settings, public.login_metrics to authenticated;   -- rows filtered by RLS below
drop policy if exists "login settings developer read" on public.login_limit_settings;
create policy "login settings developer read" on public.login_limit_settings for select to authenticated using ((select public.ops_can('view')));
drop policy if exists "login metrics developer read" on public.login_metrics;
create policy "login metrics developer read" on public.login_metrics for select to authenticated using ((select public.ops_can('view')));

-- ---------------- helpers ----------------
create or replace function public.login_metric_add(p_metric text, p_n bigint default 1)
returns void language sql security definer set search_path = public as $$
  insert into public.login_metrics (minute, metric, n) values (date_trunc('minute', now()), p_metric, p_n)
  on conflict (minute, metric) do update set n = public.login_metrics.n + excluded.n
$$;

create or replace function public.login_wait(p_strikes int)
returns int language sql stable security definer set search_path = public as $$
  select least(s.max_wait_sec, s.base_wait_sec * power(2, least(greatest(p_strikes, 0), 16))::int) from public.login_limit_settings s where s.id = 1
$$;

create or replace function public.login_row(p_key text)
returns public.login_rl_state language plpgsql security definer set search_path = public as $$
declare r public.login_rl_state;
begin
  insert into public.login_rl_state (key) values (p_key) on conflict (key) do nothing;
  select * into r from public.login_rl_state where key = p_key for update;
  return r;
end $$;

create or replace function public.login_signal(p_fp text, p_sev text, p_title text, p_summary text, p_evidence jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.ops_signal(p_fp, 'security', p_sev, 'Login', p_title, p_summary, p_evidence, 'check', 1);
exception when others then null;   -- monitoring is optional; logins never fail because of it
end $$;

-- ---------------- before signing in ----------------
-- Returns {allowed, reason, retry_after, known}. Each allowed call MUST be
-- followed by login_record (it reserves an in-flight slot).
create or replace function public.login_guard(p_acct text, p_ip text, p_pair text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.login_limit_settings;
  v_now timestamptz := now();
  v_known boolean;
  r_ip public.login_rl_state; a public.login_rl_state; p public.login_rl_state;
  v_fails int; v_wait_a int; v_wait_p int;
begin
  if p_acct !~ '^[0-9a-f]{32}$' or p_pair !~ '^[0-9a-f]{32}$' or (p_ip is not null and p_ip !~ '^[0-9a-f]{32}$') then
    raise exception 'login_guard: bad key';
  end if;
  select * into s from public.login_limit_settings where id = 1;
  v_known := exists (select 1 from public.login_known_pairs where pair = p_pair and last_success_at > v_now - make_interval(days => s.known_pair_days));

  -- 1. network (always locked first: ip -> account -> pair, so no deadlocks)
  if p_ip is not null then
    r_ip := public.login_row('i:' || p_ip);
    if r_ip.blocked_until > v_now and not v_known then
      perform public.login_metric_add('throttled_flood');
      return jsonb_build_object('allowed', false, 'reason', 'flood', 'retry_after', ceil(extract(epoch from r_ip.blocked_until - v_now))::int, 'known', v_known);
    end if;
    if r_ip.attempts_start is null or r_ip.attempts_start < v_now - make_interval(mins => s.ip_attempt_window_min) then
      r_ip.attempts := 0; r_ip.attempts_start := v_now;
    end if;
    -- only email+network pairs that never signed in here count (an attacker
    -- cannot make a pair known without the right password)
    if not v_known then r_ip.attempts := r_ip.attempts + 1; end if;
    if not v_known and r_ip.attempts > s.ip_attempt_limit then
      update public.login_rl_state set attempts = r_ip.attempts, attempts_start = r_ip.attempts_start,
             blocked_until = v_now + make_interval(secs => public.login_wait(strikes)), strikes = strikes + 1, updated_at = v_now
       where key = 'i:' || p_ip;
      perform public.login_metric_add('throttled_flood');
      perform public.login_signal('security:login_flood', 'high', 'Login flood from one network',
        'One network sent more than ' || s.ip_attempt_limit || ' login attempts in ' || s.ip_attempt_window_min || ' minutes.', jsonb_build_object('limit', s.ip_attempt_limit));
      return jsonb_build_object('allowed', false, 'reason', 'flood', 'retry_after', public.login_wait(r_ip.strikes), 'known', v_known);
    end if;
    if r_ip.suspicious_until > v_now and not v_known then
      if r_ip.minute_start is null or r_ip.minute_start < date_trunc('minute', v_now) then r_ip.minute_start := date_trunc('minute', v_now); r_ip.minute_count := 0; end if;
      if r_ip.minute_count >= s.ip_unknown_per_min then
        update public.login_rl_state set attempts = r_ip.attempts, attempts_start = r_ip.attempts_start, updated_at = v_now where key = 'i:' || p_ip;
        perform public.login_metric_add('throttled_network');
        return jsonb_build_object('allowed', false, 'reason', 'network', 'retry_after',
          greatest(1, ceil(extract(epoch from r_ip.minute_start + interval '1 minute' - v_now))::int), 'known', v_known);
      end if;
      r_ip.minute_count := r_ip.minute_count + 1;
    end if;
    update public.login_rl_state set attempts = r_ip.attempts, attempts_start = r_ip.attempts_start,
           minute_start = r_ip.minute_start, minute_count = r_ip.minute_count, updated_at = v_now where key = 'i:' || p_ip;
  else
    perform public.login_metric_add('no_ip');
  end if;

  -- 2. account (any network); a known pair skips it
  -- 2 + 3. account (any network; a known pair skips it) and email + network.
  -- Both rows are locked, then the LONGEST applicable wait is returned.
  a := public.login_row('a:' || p_acct);
  if a.inflight_at is null or a.inflight_at < v_now - make_interval(secs => s.inflight_timeout_sec) then a.inflight := 0; end if;
  p := public.login_row('p:' || p_pair);
  if p.inflight_at is null or p.inflight_at < v_now - make_interval(secs => s.inflight_timeout_sec) then p.inflight := 0; end if;
  if not v_known then
    if a.blocked_until > v_now then v_wait_a := ceil(extract(epoch from a.blocked_until - v_now))::int;
    elsif (case when a.window_start >= v_now - make_interval(mins => s.account_window_min) then a.fails else 0 end) + a.inflight >= s.account_fail_limit then v_wait_a := s.base_wait_sec;
    end if;
  end if;
  if p.blocked_until > v_now then v_wait_p := ceil(extract(epoch from p.blocked_until - v_now))::int;
  elsif (case when p.window_start >= v_now - make_interval(mins => s.pair_window_min) then p.fails else 0 end) + p.inflight >= s.pair_fail_limit then v_wait_p := s.base_wait_sec;
  end if;
  if v_wait_a is not null or v_wait_p is not null then
    if coalesce(v_wait_p, 0) >= coalesce(v_wait_a, 0) then
      perform public.login_metric_add('throttled_pair');
      if v_known then perform public.login_metric_add('throttled_known'); end if;
      return jsonb_build_object('allowed', false, 'reason', 'pair', 'retry_after', v_wait_p, 'known', v_known);
    end if;
    perform public.login_metric_add('throttled_account');
    return jsonb_build_object('allowed', false, 'reason', 'account', 'retry_after', v_wait_a, 'known', v_known);
  end if;

  -- allowed: reserve the in-flight slots
  update public.login_rl_state set inflight = a.inflight + 1, inflight_at = v_now, updated_at = v_now where key = 'a:' || p_acct;
  update public.login_rl_state set inflight = p.inflight + 1, inflight_at = v_now, updated_at = v_now where key = 'p:' || p_pair;
  return jsonb_build_object('allowed', true, 'known', v_known);
end $$;

-- one failure on a counter row: window, repeat counter, wait
create or replace function public.login_fail_row(p_key text, p_limit int, p_window_min int)
returns boolean language plpgsql security definer set search_path = public as $$
declare r public.login_rl_state; s public.login_limit_settings; v_now timestamptz := now(); v_blocked boolean := false;
begin
  select * into s from public.login_limit_settings where id = 1;
  r := public.login_row(p_key);
  if r.window_start is null or r.window_start < v_now - make_interval(mins => p_window_min) then r.fails := 0; r.window_start := v_now; end if;
  if r.last_fail_at is null or r.last_fail_at < v_now - make_interval(mins => s.escalation_reset_min) then r.strikes := 0; end if;
  r.fails := r.fails + 1;
  if r.fails >= p_limit then
    r.blocked_until := v_now + make_interval(secs => public.login_wait(r.strikes));
    r.strikes := r.strikes + 1; r.fails := 0; r.window_start := v_now; v_blocked := true;
  end if;
  update public.login_rl_state set fails = r.fails, window_start = r.window_start, strikes = r.strikes, blocked_until = r.blocked_until,
         last_fail_at = v_now, updated_at = v_now where key = p_key;
  return v_blocked;
end $$;

-- ---------------- after signing in ----------------
-- p_outcome: success | failure | auth_limited | error | other
-- p_flags: {store_errors:int, fallback:bool}
create or replace function public.login_record(p_acct text, p_ip text, p_pair text, p_outcome text, p_latency_ms int, p_flags jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  s public.login_limit_settings; v_now timestamptz := now(); r_ip public.login_rl_state; v_distinct int; v_n bigint; v_had_trouble boolean;
  v_lat int := greatest(0, coalesce(p_latency_ms, 0));
begin
  if p_acct !~ '^[0-9a-f]{32}$' or p_pair !~ '^[0-9a-f]{32}$' or (p_ip is not null and p_ip !~ '^[0-9a-f]{32}$')
     or p_outcome not in ('success', 'failure', 'auth_limited', 'error', 'other') then
    raise exception 'login_record: bad input';
  end if;
  select * into s from public.login_limit_settings where id = 1;
  -- release the in-flight slots (same lock order as login_guard)
  if p_ip is not null then perform 1 from public.login_rl_state where key = 'i:' || p_ip for update; end if;
  update public.login_rl_state set inflight = greatest(inflight - 1, 0), updated_at = v_now where key = 'a:' || p_acct;
  update public.login_rl_state set inflight = greatest(inflight - 1, 0), updated_at = v_now where key = 'p:' || p_pair;

  perform public.login_metric_add('attempts');
  perform public.login_metric_add(case p_outcome when 'success' then 'success' when 'failure' then 'failure' when 'auth_limited' then 'auth_limited' when 'error' then 'auth_error' else 'other' end);
  perform public.login_metric_add('lat_count');
  perform public.login_metric_add('lat_sum_ms', v_lat);
  perform public.login_metric_add(case when v_lat <= 100 then 'lat_le_100' when v_lat <= 250 then 'lat_le_250' when v_lat <= 500 then 'lat_le_500'
                                        when v_lat <= 1000 then 'lat_le_1000' when v_lat <= 2000 then 'lat_le_2000' when v_lat <= 5000 then 'lat_le_5000' else 'lat_gt_5000' end);
  if coalesce((p_flags->>'store_errors')::int, 0) > 0 then perform public.login_metric_add('store_errors', (p_flags->>'store_errors')::int); end if;
  if coalesce((p_flags->>'fallback')::boolean, false) then perform public.login_metric_add('fallback_used'); end if;

  if p_outcome = 'failure' then
    if public.login_fail_row('p:' || p_pair, s.pair_fail_limit, s.pair_window_min) then perform public.login_metric_add('blocked_pair'); end if;
    if public.login_fail_row('a:' || p_acct, s.account_fail_limit, s.account_window_min) then
      perform public.login_metric_add('blocked_account');
      perform public.login_signal('security:login_account_attack', 'medium', 'Many wrong passwords for one account',
        'An account reached ' || s.account_fail_limit || ' wrong passwords in ' || s.account_window_min || ' minutes, possibly from several networks.', '{}'::jsonb);
    end if;
    if p_ip is not null then
      r_ip := public.login_row('i:' || p_ip);
      if r_ip.window_start is null or r_ip.window_start < v_now - make_interval(mins => s.ip_window_min) then r_ip.fails := 0; r_ip.successes := 0; r_ip.window_start := v_now; end if;
      r_ip.fails := r_ip.fails + 1;
      insert into public.login_ip_accounts (ip, acct, failed_at) values (p_ip, p_acct, v_now)
        on conflict (ip, acct) do update set failed_at = excluded.failed_at;
      select count(*) into v_distinct from public.login_ip_accounts where ip = p_ip and failed_at > v_now - make_interval(mins => s.ip_window_min);
      if (r_ip.fails >= s.ip_fail_limit or v_distinct >= s.ip_distinct_accounts)
         and r_ip.fails * 100 >= s.ip_min_fail_pct * (r_ip.fails + r_ip.successes)
         and coalesce(r_ip.suspicious_until, '-infinity') <= v_now then
        r_ip.suspicious_until := v_now + make_interval(mins => s.ip_window_min);
        perform public.login_metric_add('network_marked');
        perform public.login_signal('security:login_network', 'high', 'Many failed logins from one network',
          'One network had ' || r_ip.fails || ' wrong passwords for ' || v_distinct || ' different accounts in ' || s.ip_window_min || ' minutes. New sign-ins from it are slowed; known students are not.',
          jsonb_build_object('failures', r_ip.fails, 'accounts', v_distinct));
      end if;
      update public.login_rl_state set fails = r_ip.fails, successes = r_ip.successes, window_start = r_ip.window_start, suspicious_until = r_ip.suspicious_until,
             last_fail_at = v_now, updated_at = v_now where key = 'i:' || p_ip;
    end if;
    select n into v_n from public.login_metrics where minute = date_trunc('minute', v_now) and metric = 'failure';
    if v_n = s.alert_failures_per_min then
      perform public.login_signal('security:login_failure_spike', 'high', 'Spike in failed logins',
        v_n || ' failed logins in one minute across the platform.', jsonb_build_object('per_minute', v_n));
    end if;
  elsif p_outcome = 'success' then
    select (strikes > 0 or blocked_until is not null) into v_had_trouble from public.login_rl_state where key = 'p:' || p_pair;
    if coalesce(v_had_trouble, false) then perform public.login_metric_add('throttled_then_success'); end if;
    delete from public.login_rl_state where key = 'p:' || p_pair;
    if p_ip is not null then
      update public.login_rl_state
         set successes = case when window_start is null or window_start < v_now - make_interval(mins => s.ip_window_min) then 1 else successes + 1 end,
             fails = case when window_start is null or window_start < v_now - make_interval(mins => s.ip_window_min) then 0 else fails end,
             window_start = case when window_start is null or window_start < v_now - make_interval(mins => s.ip_window_min) then v_now else window_start end,
             updated_at = v_now
       where key = 'i:' || p_ip;
    end if;
    insert into public.login_known_pairs (pair, last_success_at) values (p_pair, v_now)
      on conflict (pair) do update set last_success_at = excluded.last_success_at;
  elsif p_outcome = 'auth_limited' then
    perform public.login_signal('auth:upstream_limit', 'high', 'Supabase Auth is refusing sign-ins (rate limit)',
      'Supabase Auth answered "too many requests" to the login function. Students may be unable to sign in.', '{}'::jsonb);
  end if;
end $$;

-- ---------------- developer view (aggregated only) ----------------
create or replace function public.login_report_internal(p_hours int default 24)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_hours int := least(greatest(coalesce(p_hours, 24), 1), 720); v_from timestamptz; t jsonb; c bigint; b jsonb; v_out jsonb;
begin
  v_from := now() - make_interval(hours => v_hours);
  select coalesce(jsonb_object_agg(metric, n), '{}'::jsonb) into t from (select metric, sum(n) n from public.login_metrics where minute >= v_from group by metric) x;
  c := coalesce((t->>'lat_count')::bigint, 0);
  b := jsonb_build_object('le_100', coalesce((t->>'lat_le_100')::bigint, 0), 'le_250', coalesce((t->>'lat_le_250')::bigint, 0), 'le_500', coalesce((t->>'lat_le_500')::bigint, 0),
         'le_1000', coalesce((t->>'lat_le_1000')::bigint, 0), 'le_2000', coalesce((t->>'lat_le_2000')::bigint, 0), 'le_5000', coalesce((t->>'lat_le_5000')::bigint, 0), 'gt_5000', coalesce((t->>'lat_gt_5000')::bigint, 0));
  v_out := jsonb_build_object(
    'hours', v_hours,
    'totals', t,
    'latency', jsonb_build_object('count', c, 'avg_ms', case when c > 0 then round((t->>'lat_sum_ms')::numeric / c) end,
       'p50_ms_at_most', public.login_pctl(b, c, 0.50), 'p95_ms_at_most', public.login_pctl(b, c, 0.95), 'p99_ms_at_most', public.login_pctl(b, c, 0.99)),
    'per_hour', coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'attempts', a, 'failed', f, 'throttled', th) order by h)
        from (select date_trunc('hour', minute) h, sum(n) filter (where metric = 'attempts') a, sum(n) filter (where metric = 'failure') f,
                     sum(n) filter (where metric like 'throttled\_%' and metric not in ('throttled_known', 'throttled_then_success')) th
                from public.login_metrics where minute >= v_from group by 1) x), '[]'::jsonb),
    'active_waits', jsonb_build_object(
       'pairs', (select count(*) from public.login_rl_state where key like 'p:%' and blocked_until > now()),
       'accounts', (select count(*) from public.login_rl_state where key like 'a:%' and blocked_until > now()),
       'networks_blocked', (select count(*) from public.login_rl_state where key like 'i:%' and blocked_until > now()),
       'networks_suspicious', (select count(*) from public.login_rl_state where key like 'i:%' and suspicious_until > now())),
    'settings', (select to_jsonb(s) - 'id' - 'updated_by' from public.login_limit_settings s where id = 1));
  return v_out;
end $$;

-- upper bound of the bucket holding the q-th request (histogram, so "at most")
create or replace function public.login_pctl(b jsonb, c bigint, q numeric)
returns int language plpgsql immutable as $$
declare acc bigint := 0; k text; lim int;
begin
  if c is null or c = 0 then return null; end if;
  foreach k in array array['le_100', 'le_250', 'le_500', 'le_1000', 'le_2000', 'le_5000'] loop
    acc := acc + coalesce((b->>k)::bigint, 0);
    lim := substr(k, 4)::int;
    if acc >= ceil(c * q) then return lim; end if;
  end loop;
  return 999999;   -- above 5 s
end $$;

create or replace function public.login_report(p_hours int default 24)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.ops_can('view') then return jsonb_build_object('ok', false, 'error', 'Not allowed.'); end if;
  return public.login_report_internal(p_hours) || jsonb_build_object('ok', true);
end $$;

-- developers change limits within safe bounds; never switched off from the app
create or replace function public.login_limits_update(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); old public.login_limit_settings; k text; v int;
  bounds jsonb := '{"pair_fail_limit":[3,20],"pair_window_min":[5,120],"account_fail_limit":[5,100],"account_window_min":[5,120],
    "ip_fail_limit":[20,5000],"ip_window_min":[5,120],"ip_distinct_accounts":[5,1000],"ip_unknown_per_min":[5,1000],
    "ip_attempt_limit":[60,20000],"ip_attempt_window_min":[1,60],"base_wait_sec":[5,300],"max_wait_sec":[60,3600],
    "escalation_reset_min":[15,1440],"ip_min_fail_pct":[10,100],"known_pair_days":[1,90],"alert_failures_per_min":[10,100000]}'::jsonb;
  vals jsonb := '{}'::jsonb;
begin
  if v_uid is null or not public.ops_has_perm(v_uid, 'approve') then
    begin insert into public.security_events (key, endpoint, kind, detail) values ('acct:' || coalesce(v_uid::text, 'anon'), 'login_limits_update', 'unauthorized', '{}'::jsonb);
    exception when others then null; end;
    return jsonb_build_object('ok', false, 'error', 'Not allowed.');
  end if;
  if p is null or jsonb_typeof(p) <> 'object' or p = '{}'::jsonb then return jsonb_build_object('ok', false, 'error', 'Bad request.'); end if;
  for k in select jsonb_object_keys(p) loop
    if not bounds ? k then return jsonb_build_object('ok', false, 'error', 'Unknown setting: ' || left(k, 40)); end if;
    if (p->>k) !~ '^[0-9]{1,6}$' then return jsonb_build_object('ok', false, 'error', k || ' must be a whole number.'); end if;
    v := (p->>k)::int;
    if v < (bounds->k->>0)::int or v > (bounds->k->>1)::int then
      return jsonb_build_object('ok', false, 'error', k || ' must be between ' || (bounds->k->>0) || ' and ' || (bounds->k->>1) || '.');
    end if;
    vals := vals || jsonb_build_object(k, v);
  end loop;
  select * into old from public.login_limit_settings where id = 1 for update;
  if coalesce((vals->>'max_wait_sec')::int, old.max_wait_sec) < coalesce((vals->>'base_wait_sec')::int, old.base_wait_sec) then
    return jsonb_build_object('ok', false, 'error', 'The longest wait must be at least the first wait.');
  end if;
  update public.login_limit_settings set
    pair_fail_limit = coalesce((vals->>'pair_fail_limit')::int, pair_fail_limit), pair_window_min = coalesce((vals->>'pair_window_min')::int, pair_window_min),
    account_fail_limit = coalesce((vals->>'account_fail_limit')::int, account_fail_limit), account_window_min = coalesce((vals->>'account_window_min')::int, account_window_min),
    ip_fail_limit = coalesce((vals->>'ip_fail_limit')::int, ip_fail_limit), ip_window_min = coalesce((vals->>'ip_window_min')::int, ip_window_min),
    ip_distinct_accounts = coalesce((vals->>'ip_distinct_accounts')::int, ip_distinct_accounts), ip_unknown_per_min = coalesce((vals->>'ip_unknown_per_min')::int, ip_unknown_per_min),
    ip_attempt_limit = coalesce((vals->>'ip_attempt_limit')::int, ip_attempt_limit), ip_attempt_window_min = coalesce((vals->>'ip_attempt_window_min')::int, ip_attempt_window_min),
    base_wait_sec = coalesce((vals->>'base_wait_sec')::int, base_wait_sec), max_wait_sec = coalesce((vals->>'max_wait_sec')::int, max_wait_sec),
    escalation_reset_min = coalesce((vals->>'escalation_reset_min')::int, escalation_reset_min), ip_min_fail_pct = coalesce((vals->>'ip_min_fail_pct')::int, ip_min_fail_pct), known_pair_days = coalesce((vals->>'known_pair_days')::int, known_pair_days),
    alert_failures_per_min = coalesce((vals->>'alert_failures_per_min')::int, alert_failures_per_min),
    updated_at = now(), updated_by = v_uid
  where id = 1;
  perform public.ops_audit_add(null, 'developer', v_uid, 'login_limits_changed', 'saved',
    jsonb_build_object('changed', vals, 'before', (select jsonb_object_agg(key, value) from jsonb_each(to_jsonb(old)) where vals ? key)));
  return jsonb_build_object('ok', true);
end $$;

-- ---------------- housekeeping ----------------
create or replace function public.login_cleanup()
returns void language plpgsql security definer set search_path = public as $$
declare d int := (select known_pair_days from public.login_limit_settings where id = 1);
begin
  delete from public.login_rl_state where updated_at < now() - interval '1 day'
     and coalesce(blocked_until, '-infinity') < now() and coalesce(suspicious_until, '-infinity') < now();
  delete from public.login_ip_accounts where failed_at < now() - interval '2 hours';
  delete from public.login_known_pairs where last_success_at < now() - make_interval(days => d);
  delete from public.login_metrics where minute < now() - interval '30 days';
end $$;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'login-cleanup';
    perform cron.schedule('login-cleanup', '17 * * * *', 'select public.login_cleanup()');
  end if;
end $$;

-- ---------------- who may call what ----------------
revoke all on function public.login_metric_add(text, bigint), public.login_wait(int), public.login_row(text), public.login_signal(text, text, text, text, jsonb),
  public.login_guard(text, text, text), public.login_fail_row(text, int, int), public.login_record(text, text, text, text, int, jsonb),
  public.login_report_internal(int), public.login_cleanup() from public, anon, authenticated;
grant execute on function public.login_guard(text, text, text), public.login_record(text, text, text, text, int, jsonb) to service_role;
revoke all on function public.login_report(int), public.login_limits_update(jsonb) from public, anon;
grant execute on function public.login_report(int), public.login_limits_update(jsonb) to authenticated;
revoke all on function public.login_pctl(jsonb, bigint, numeric) from public, anon, authenticated;
