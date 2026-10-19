-- ============================================================
-- ClickFood: AI monitoring, incidents, self-healing and security limits
-- (2026-10-16). Runs after notification_queue.sql and allowed_domains.sql.
--
-- What this adds (all developer-only, default DENY):
--   ops_settings            mode (monitoring_only by default), AI limits, thresholds
--   ops_permissions         per-developer permissions (view / approve / chat)
--   ops_incidents           one row per problem; repeats are grouped (fingerprint)
--   ops_events              raw evidence (redacted): app errors, check findings
--   ops_reports             AI investigation reports, versioned, never overwritten
--   ops_actions             the ONLY recovery actions that exist (registry)
--   ops_recovery_attempts   every proposed/approved/run action + verification
--   ops_audit               who did what, when (incl. refused access)
--   ops_ai_usage            AI calls, tokens, estimated cost per day
--   ops_check_runs          heartbeat of the scheduled checks
--   rl_counters / rl_blocks / security_events   shared rate limiter + temp blocks
--   ai_conversations / ai_messages              AI Developer Assistant history
-- Detection: ops_tick() every 2 minutes (pg_cron) runs deterministic checks
-- over existing records. The AI is never in the path of orders, payments or
-- rate limits; it only reads redacted, aggregated evidence. Actions marked
-- high risk are never executed by the system, only approved for a person to do.
-- Safe to run more than once. Rollback: ops_monitoring_rollback.sql
-- ============================================================

-- ---------- 0. helpers ----------
create or replace function public.ops_sev_rank(p text)
returns int language sql immutable as $$
  select case p when 'critical' then 4 when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end
$$;

-- Removes secrets and personal details from free text before it is stored or
-- sent to the AI: emails, tokens/keys, bearer values, long numbers (phones,
-- student numbers, card numbers), and cuts it to 500 characters.
create or replace function public.ops_redact(p text)
returns text language sql immutable as $$
  select left(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(coalesce(p, ''),
      '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email]', 'g'),
      'eyJ[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]+){0,2}', '[token]', 'g'),
      '(sb_(publishable|secret)_|sk-ant-|sk-|sk_live_|sk_test_|re_|rk_)[A-Za-z0-9_-]{6,}', '[secret]', 'g'),
      '(?i)(bearer|apikey|api_key|password|passwd|secret|token)(["'':= ]+)[^\s"'',&]+', '\1\2[redacted]', 'g'),
      '(?<![A-Za-z0-9])[uU][0-9]{8}(?![0-9])', '[student number]', 'g'),
      -- phone / card / ID numbers (9+ digits, single space or dash separators); dates,
      -- incident IDs (INC-2026-00001) and record IDs are kept
      '(?<![A-Za-z0-9-])(?![0-9]{4}-[0-9]{2}-[0-9]{2})[+]?[0-9](?:[ -]?[0-9]){8,}(?![A-Za-z0-9-])', '[number]', 'g'),
    500)
$$;

-- Trusted client address for rate limiting, from the platform's own headers
-- (Cloudflare sets cf-connecting-ip and the client can't override it). Only
-- a short hash is kept, never the raw address.
create or replace function public.ops_client_key()
returns text language plpgsql stable as $$
declare h json; ip text;
begin
  begin h := nullif(current_setting('request.headers', true), '')::json; exception when others then h := null; end;
  ip := coalesce(h->>'cf-connecting-ip', btrim(split_part(coalesce(h->>'x-forwarded-for', ''), ',', 1)));
  if coalesce(ip, '') = '' then return null; end if;
  return 'ip:' || left(encode(sha256(convert_to('clickfood-rl:' || ip, 'UTF8')), 'hex'), 16);
end $$;

-- ---------- 1. settings + permissions ----------
create table if not exists public.ops_settings (
  id int primary key default 1 check (id = 1),
  mode text not null default 'monitoring_only' check (mode in ('monitoring_only', 'auto_recovery')),
  ai_enabled boolean not null default true,
  ai_daily_limit int not null default 30 check (ai_daily_limit between 0 and 500),
  ai_min_severity text not null default 'medium' check (ai_min_severity in ('informational', 'low', 'medium', 'high', 'critical')),
  ai_model text not null default 'claude-haiku-5-5',
  assistant_model text not null default 'claude-haiku-5-5',
  assistant_daily_limit int not null default 100 check (assistant_daily_limit between 0 and 2000),
  ai_price_in_per_mtok numeric not null default 1,   -- USD per million input tokens (estimate, editable)
  ai_price_out_per_mtok numeric not null default 5,  -- USD per million output tokens (estimate, editable)
  alert_min_severity text not null default 'high' check (alert_min_severity in ('informational', 'low', 'medium', 'high', 'critical')),
  thresholds jsonb not null default '{
    "stuck_order_minutes": 120,
    "login_failures_15m": 20,
    "signups_10m": 40,
    "invalid_signatures_1h": 3,
    "server_call_errors_30m": 3,
    "orders_per_account_10m": 15,
    "client_errors_per_minute": 300,
    "coordinated_sources": 5
  }'::jsonb,
  retention_days int not null default 90 check (retention_days between 7 and 730),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.ops_settings (id) values (1) on conflict do nothing;

create table if not exists public.ops_permissions (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  can_view boolean not null default true,
  can_approve boolean not null default true,
  can_chat boolean not null default true,
  updated_at timestamptz not null default now()
);

-- A developer has view/approve/chat unless a row switches it off. Checked on
-- every call, so a revoked permission takes effect at once.
create or replace function public.ops_has_perm(p_user uuid, p_perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = p_user and p.role = 'developer' and coalesce(p.active, true))
     and coalesce((select case p_perm when 'view' then can_view when 'approve' then can_approve when 'chat' then can_chat else false end
                     from public.ops_permissions where user_id = p_user), p_perm in ('view', 'approve', 'chat'))
$$;
create or replace function public.ops_can(p_perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and public.ops_has_perm(auth.uid(), p_perm)
$$;

-- ---------- 2. incidents, evidence, reports, actions, attempts, audit ----------
create sequence if not exists public.ops_incident_seq;
create table if not exists public.ops_incidents (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique default ('INC-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.ops_incident_seq')::text, 5, '0')),
  fingerprint text not null,
  source text not null default 'check' check (source in ('check', 'frontend', 'security', 'manual')),
  category text not null check (category in ('frontend', 'notifications', 'email', 'scheduled_jobs', 'server_calls', 'orders', 'payments', 'security', 'database', 'monitoring')),
  severity text not null check (severity in ('informational', 'low', 'medium', 'high', 'critical')),
  severity_reason text,
  service text not null,
  title text not null,
  summary text,
  status text not null default 'detected' check (status in ('detected', 'investigating', 'analysis_complete', 'awaiting_approval', 'recovery_in_progress',
    'verification_in_progress', 'resolved', 'partially_resolved', 'unresolved', 'monitoring', 'recovery_failed')),
  ai_status text not null default 'not_requested' check (ai_status in ('not_requested', 'queued', 'running', 'complete', 'failed', 'skipped_limit', 'skipped_disabled', 'skipped_severity')),
  recovery_status text not null default 'none' check (recovery_status in ('none', 'awaiting_approval', 'approved', 'rejected', 'running', 'verifying', 'verified', 'verification_failed', 'failed', 'manual')),
  occurrences int not null default 1,
  clear_runs int not null default 0,
  evidence jsonb not null default '{}'::jsonb,
  correlation_ids text[] not null default '{}',
  recurrence_of uuid references public.ops_incidents(id) on delete set null,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  detected_at timestamptz not null default now(),
  investigation_started_at timestamptz,
  investigation_completed_at timestamptz,
  resolved_at timestamptz,
  resolution text,
  reviewed boolean not null default false,
  reviewed_by uuid,
  reviewed_at timestamptz,
  alert_level int not null default 0,
  updated_at timestamptz not null default now()
);
-- one OPEN incident per problem: repeats add to it instead of creating new ones
create unique index if not exists ops_incidents_open_fp on public.ops_incidents (fingerprint) where status <> 'resolved';
create index if not exists ops_incidents_detected on public.ops_incidents (detected_at desc);
create index if not exists ops_incidents_status on public.ops_incidents (status);

create table if not exists public.ops_events (
  id bigint generated always as identity primary key,
  incident_id uuid references public.ops_incidents(id) on delete cascade,
  source text not null,
  fingerprint text,
  category text,
  message text,
  context jsonb not null default '{}'::jsonb,
  app text,
  route text,
  correlation_id text,
  created_at timestamptz not null default now()
);
create index if not exists ops_events_incident on public.ops_events (incident_id, created_at desc);
create index if not exists ops_events_created on public.ops_events (created_at);

create table if not exists public.ops_reports (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.ops_incidents(id) on delete cascade,
  version int not null,
  status text not null check (status in ('complete', 'failed')),
  model text,
  report jsonb not null default '{}'::jsonb,   -- validated structure (facts, hypotheses, ...)
  recommended_action text,
  error text,
  input_tokens int,
  output_tokens int,
  cost_usd numeric,
  requested_by text not null default 'system',
  created_at timestamptz not null default now(),
  unique (incident_id, version)
);

create table if not exists public.ops_actions (
  id text primary key,
  label text not null,
  risk text not null check (risk in ('low', 'high')),
  auto_allowed boolean not null default false,
  description text not null,
  verification text not null
);
insert into public.ops_actions (id, label, risk, auto_allowed, description, verification) values
  ('retry_dead_notifications', 'Retry failed notifications (one more try each)', 'low', true, 'Puts notification jobs that died in the last 24 hours back in the queue for one more try and wakes the worker.', 'Each retried job must reach sent, delivered or skipped.'),
  ('retry_failed_emails', 'Retry failed emails (one more try each)', 'low', true, 'Sends emails that failed in the last 24 hours once more (bounced addresses are never retried).', 'Each retried email must reach sent or delivered.'),
  ('kick_notification_worker', 'Wake the notification worker', 'low', true, 'Calls the notification worker now instead of waiting for its schedule.', 'No notification job may be waiting more than 2 minutes.'),
  ('rerun_collection_expiry', 'Re-run the collection-time check', 'low', true, 'Runs the existing job that handles orders whose collection time has passed.', 'No order may be past its collection deadline without being handled.'),
  ('rerun_diagnostics', 'Re-run the checks', 'low', true, 'Runs all monitoring checks now.', 'The problem must no longer be detected.'),
  ('manual_payment_reconciliation', 'Check the payment with PayFast and fix the order by hand', 'high', false, 'A person compares the PayFast record with the order and corrects it. The system never changes payments.', 'A person confirms the order matches the verified PayFast payment.'),
  ('manual_refund_review', 'Review a refund', 'high', false, 'A person decides whether a refund is due and issues it in PayFast. The system never refunds.', 'A person confirms the refund in PayFast.'),
  ('manual_code_fix', 'Change the app code', 'high', false, 'A code change is prepared, reviewed and tested before a person deploys it.', 'Tests pass and the problem stops after the deploy.'),
  ('manual_data_fix', 'Change or delete data', 'high', false, 'A person changes or deletes specific records. The system never does this.', 'A person confirms the records are correct.'),
  ('manual_security_change', 'Change security settings or block a source', 'high', false, 'A person changes limits, blocks or security rules.', 'The abusive traffic stops and real students are not blocked.'),
  ('manual_config_change', 'Change a setting', 'high', false, 'A person changes a setting (for example sign-up limits or CAPTCHA).', 'The setting is in place and the problem stops.')
on conflict (id) do update set label = excluded.label, risk = excluded.risk, auto_allowed = excluded.auto_allowed,
  description = excluded.description, verification = excluded.verification;

create table if not exists public.ops_recovery_attempts (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.ops_incidents(id) on delete cascade,
  action_id text not null references public.ops_actions(id),
  requested_by text not null check (requested_by in ('ai', 'assistant', 'developer', 'system')),
  requested_by_user uuid,
  reason text,
  status text not null check (status in ('awaiting_approval', 'approved', 'rejected', 'running', 'verifying', 'succeeded', 'failed', 'skipped', 'approved_manual')),
  authorization_note text,
  approved_by uuid,
  approved_at timestamptz,
  input jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  verify_after timestamptz,
  verify_deadline timestamptz,
  verification jsonb,
  verification_passed boolean,
  failure text,
  created_at timestamptz not null default now()
);
-- never two live attempts of the same action for the same incident
create unique index if not exists ops_attempts_live on public.ops_recovery_attempts (incident_id, action_id)
  where status in ('awaiting_approval', 'approved', 'running', 'verifying');
create index if not exists ops_attempts_incident on public.ops_recovery_attempts (incident_id, created_at desc);

create table if not exists public.ops_audit (
  id bigint generated always as identity primary key,
  incident_id uuid references public.ops_incidents(id) on delete cascade,
  actor_kind text not null check (actor_kind in ('developer', 'system', 'ai', 'assistant', 'unknown')),
  actor uuid,
  action text not null,
  outcome text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ops_audit_incident on public.ops_audit (incident_id, created_at desc);
create index if not exists ops_audit_created on public.ops_audit (created_at desc);

create table if not exists public.ops_ai_usage (
  day date not null,
  kind text not null check (kind in ('investigation', 'assistant', 'transcription')),
  calls int not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  audio_seconds int not null default 0,
  cost_usd numeric not null default 0,
  primary key (day, kind)
);

create table if not exists public.ops_check_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  ok boolean not null,
  findings int not null default 0,
  duration_ms int,
  error text
);
create index if not exists ops_check_runs_ran on public.ops_check_runs (ran_at desc);

-- worker URL + secret (filled in on deploy; nobody but the server can read it)
create table if not exists public.ops_function_config (
  id int primary key default 1 check (id = 1),
  investigate_url text not null,
  secret text not null
);

-- ---------- 3. shared rate limiter + temporary blocks ----------
create table if not exists public.rl_counters (
  key text not null,
  endpoint text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (key, endpoint, window_start)
);
create table if not exists public.rl_blocks (
  key text not null,
  endpoint text not null,
  reason text,
  level int not null default 1,
  blocked_until timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (key, endpoint)
);
create table if not exists public.security_events (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('rate_limited', 'blocked', 'unblocked', 'captcha_failed', 'unauthorized')),
  key text,
  endpoint text not null,
  count int,
  window_seconds int,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists security_events_created on public.security_events (created_at desc);
create index if not exists security_events_endpoint on public.security_events (endpoint, created_at desc);

-- Fixed-window limiter shared by every caller (Edge Functions, triggers, RPCs):
-- the counter lives in the database, so all instances see the same numbers.
-- Over the limit: refused with retry_after (seconds). The first violation in a
-- window is recorded; 3 windows over the limit within 10 minutes = a temporary
-- block (15 min, then 30, 60, 120 for repeat offenders).
create or replace function public.rl_hit(p_key text, p_endpoint text, p_limit int, p_window_seconds int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  b public.rl_blocks;
  w timestamptz;
  c int;
  v_recent int;
  v_level int;
begin
  if coalesce(p_key, '') = '' then return jsonb_build_object('allowed', true, 'reason', 'no key'); end if;
  select * into b from public.rl_blocks where key = p_key and endpoint = p_endpoint and blocked_until > now();
  if found then
    return jsonb_build_object('allowed', false, 'blocked', true, 'retry_after', greatest(1, ceil(extract(epoch from b.blocked_until - now()))::int));
  end if;
  w := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rl_counters (key, endpoint, window_start, count) values (p_key, p_endpoint, w, 1)
  on conflict (key, endpoint, window_start) do update set count = public.rl_counters.count + 1
  returning count into c;
  if c <= p_limit then
    return jsonb_build_object('allowed', true, 'remaining', p_limit - c);
  end if;
  if c = p_limit + 1 then
    insert into public.security_events (kind, key, endpoint, count, window_seconds) values ('rate_limited', p_key, p_endpoint, c, p_window_seconds);
    select count(*) into v_recent from public.security_events
     where kind = 'rate_limited' and key = p_key and endpoint = p_endpoint and created_at > now() - interval '10 minutes';
    if v_recent >= 3 then
      select coalesce(max(level), 0) + 1 into v_level from public.rl_blocks where key = p_key and endpoint = p_endpoint;
      v_level := least(v_level, 4);
      insert into public.rl_blocks (key, endpoint, reason, level, blocked_until)
      values (p_key, p_endpoint, 'Over the limit in 3 windows within 10 minutes', v_level, now() + (interval '15 minutes' * power(2, v_level - 1)))
      on conflict (key, endpoint) do update set level = excluded.level, blocked_until = excluded.blocked_until, reason = excluded.reason, created_at = now();
      insert into public.security_events (kind, key, endpoint, detail) values ('blocked', p_key, p_endpoint, jsonb_build_object('level', v_level, 'minutes', 15 * power(2, v_level - 1)));
    end if;
  end if;
  return jsonb_build_object('allowed', false, 'retry_after', greatest(1, ceil(extract(epoch from (w + make_interval(secs => p_window_seconds)) - now()))::int));
end $$;

-- Too many orders from one account in 10 minutes: refused before anything else.
create or replace function public.limit_order_rate()
returns trigger language plpgsql security definer set search_path = public as $$
declare r jsonb; v_limit int;
begin
  if auth.uid() is null then return new; end if;
  v_limit := coalesce((select (thresholds->>'orders_per_account_10m')::int from public.ops_settings where id = 1), 15);
  r := public.rl_hit('acct:' || auth.uid(), 'orders', v_limit, 600);
  if not coalesce((r->>'allowed')::boolean, true) then
    raise exception 'You are placing orders too quickly. Please try again in % minutes.', greatest(1, ceil(coalesce((r->>'retry_after')::int, 60) / 60.0)::int)
      using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_a1_limit_order_rate on public.orders;
create trigger trg_a1_limit_order_rate before insert on public.orders
  for each row execute function public.limit_order_rate();

-- ---------- 4. recording a problem (grouped by fingerprint) ----------
create or replace function public.ops_audit_add(p_incident uuid, p_kind text, p_actor uuid, p_action text, p_outcome text, p_meta jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.ops_audit (incident_id, actor_kind, actor, action, outcome, meta) values (p_incident, p_kind, p_actor, p_action, p_outcome, coalesce(p_meta, '{}'::jsonb))
$$;

create or replace function public.ops_signal(p_fingerprint text, p_category text, p_severity text, p_service text, p_title text,
                                             p_summary text, p_evidence jsonb, p_source text default 'check', p_count int default 1)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  i public.ops_incidents;
  s public.ops_settings;
  v_new boolean;
  v_prev uuid;
  v_old_occ int;
  v_old_sev text;
begin
  select * into s from public.ops_settings where id = 1;
  select id into v_prev from public.ops_incidents where fingerprint = p_fingerprint and status = 'resolved' order by resolved_at desc nulls last limit 1;
  select occurrences, severity into v_old_occ, v_old_sev from public.ops_incidents where fingerprint = p_fingerprint and status <> 'resolved';
  insert into public.ops_incidents (fingerprint, source, category, severity, severity_reason, service, title, summary, evidence, recurrence_of, occurrences)
  values (p_fingerprint, p_source, p_category, p_severity, 'Set by the ' || p_source || ' rule for ' || p_category, p_service, left(p_title, 200),
          left(public.ops_redact(p_summary), 1000), coalesce(p_evidence, '{}'::jsonb), v_prev, greatest(coalesce(p_count, 1), 1))
  on conflict (fingerprint) where status <> 'resolved' do update set
    occurrences = public.ops_incidents.occurrences + greatest(coalesce(p_count, 1), 1),
    last_seen = now(),
    clear_runs = 0,
    evidence = case when p_evidence is null or p_evidence = '{}'::jsonb then public.ops_incidents.evidence else p_evidence end,
    summary = coalesce(left(public.ops_redact(p_summary), 1000), public.ops_incidents.summary),
    severity = case when public.ops_sev_rank(excluded.severity) > public.ops_sev_rank(public.ops_incidents.severity) then excluded.severity else public.ops_incidents.severity end,
    severity_reason = case when public.ops_sev_rank(excluded.severity) > public.ops_sev_rank(public.ops_incidents.severity)
                           then 'Raised: the problem got worse (' || excluded.severity || ')' else public.ops_incidents.severity_reason end,
    -- a problem that was being watched comes back: it needs attention again
    status = case when public.ops_incidents.status in ('monitoring', 'partially_resolved') then 'detected' else public.ops_incidents.status end,
    updated_at = now()
  returning * into i;
  v_new := v_old_occ is null;

  if v_new then
    perform public.ops_audit_add(i.id, 'system', null, 'detected', i.severity, jsonb_build_object('source', p_source, 'recurrence_of', v_prev));
  end if;

  -- AI investigation: new incidents (or ones that got worse) at or above the
  -- minimum severity; never for problems of the monitoring system itself
  if i.category <> 'monitoring' and i.ai_status in ('not_requested', 'skipped_severity')
     and (v_new or public.ops_sev_rank(i.severity) > public.ops_sev_rank(coalesce(v_old_sev, 'informational'))) then
    update public.ops_incidents set ai_status = case
        when not s.ai_enabled then 'skipped_disabled'
        when public.ops_sev_rank(i.severity) < public.ops_sev_rank(s.ai_min_severity) then 'skipped_severity'
        else 'queued' end
     where id = i.id;
  end if;

  -- alerts: once when it first reaches the alert level, again at 10/100/1000 repeats
  if public.ops_sev_rank(i.severity) >= public.ops_sev_rank(s.alert_min_severity) then
    if i.alert_level = 0 then
      perform public.ops_alert(i.id, 'New ' || i.severity || ' incident');
      update public.ops_incidents set alert_level = 1 where id = i.id;
    elsif (i.occurrences >= 10 and i.alert_level < 2) or (i.occurrences >= 100 and i.alert_level < 3) or (i.occurrences >= 1000 and i.alert_level < 4) then
      perform public.ops_alert(i.id, 'Repeated ' || i.occurrences || ' times');
      update public.ops_incidents set alert_level = alert_level + 1 where id = i.id;
    end if;
  end if;
  return i.id;
end $$;

-- ---------- 5. developer alerts (never contain logs or personal data) ----------
create or replace function public.ops_alert(p_incident uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare i public.ops_incidents; d record; v_msg text;
begin
  select * into i from public.ops_incidents where id = p_incident;
  if not found then return; end if;
  v_msg := 'ClickFood ' || upper(i.severity) || ': ' || i.ref || ' ' || i.title || ' (' || p_reason || ').';
  begin
    perform public.notify_developers(left(v_msg, 300), 'ops_alert', jsonb_build_object('kind', 'incident', 'incident_id', i.id, 'ref', i.ref));
    for d in select p.id, p.email, p.name from public.profiles p
              where p.role = 'developer' and coalesce(p.active, true) and coalesce(p.email, '') <> '' loop
      perform public.queue_email('ops_alert', 'incident', i.id, d.id, d.email, d.name,
        jsonb_build_object('ref', i.ref, 'title', i.title, 'severity', i.severity, 'reason', p_reason));
    end loop;
    perform public.ops_audit_add(i.id, 'system', null, 'alert', 'queued', jsonb_build_object('reason', p_reason));
  exception when others then
    -- an alert failure never loses the incident
    perform public.ops_audit_add(i.id, 'system', null, 'alert', 'failed', jsonb_build_object('reason', p_reason, 'error', left(sqlerrm, 200)));
  end;
end $$;

-- ---------- 6. app error reports (browser, signed in or not) ----------
-- Redacted on the server again whatever the app sends; limited per source
-- and overall so a broken page or an attacker can't flood the table.
create or replace function public.ops_report_client_error(p_app text, p_kind text, p_message text, p_route text,
                                                          p_fingerprint text, p_context jsonb, p_correlation text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_key text := coalesce(case when auth.uid() is not null then 'acct:' || auth.uid() end, public.ops_client_key(), 'anon');
  v_global int := coalesce((select (thresholds->>'client_errors_per_minute')::int from public.ops_settings where id = 1), 300);
  r jsonb;
  v_fp text;
  v_app text := case when p_app in ('customer', 'staff', 'developer') then p_app else 'unknown' end;
  v_kind text := case when p_kind in ('error', 'unhandled_rejection', 'api_error', 'network_error', 'auth_error', 'checkout_error', 'login_error') then p_kind else 'error' end;
  v_route text := left(regexp_replace(coalesce(p_route, ''), '[?#].*$', ''), 80);
  v_sev text;
  v_msg text := public.ops_redact(left(coalesce(p_message, ''), 600));
  v_ctx jsonb;
  v_id uuid;
begin
  r := public.rl_hit(v_key, 'client_errors', 30, 60);
  if not coalesce((r->>'allowed')::boolean, true) then return jsonb_build_object('ok', false, 'reason', 'rate_limited'); end if;
  r := public.rl_hit('global', 'client_errors', v_global, 60);
  if not coalesce((r->>'allowed')::boolean, true) then return jsonb_build_object('ok', false, 'reason', 'busy'); end if;
  -- only short, known context fields are kept, all redacted
  v_ctx := jsonb_strip_nulls(jsonb_build_object(
    'status', left(coalesce(p_context->>'status', ''), 10),
    'endpoint', left(public.ops_redact(regexp_replace(coalesce(p_context->>'endpoint', ''), '[?#].*$', '')), 120),
    'source', left(public.ops_redact(coalesce(p_context->>'source', '')), 120),
    'line', left(coalesce(p_context->>'line', ''), 10),
    'online', left(coalesce(p_context->>'online', ''), 5),
    'role', case when auth.uid() is not null then (select role from public.profiles where id = auth.uid()) end));
  v_fp := 'frontend:' || v_app || ':' || v_kind || ':' || left(regexp_replace(coalesce(nullif(p_fingerprint, ''), v_msg), '[^A-Za-z0-9:_ .-]', '', 'g'), 120);
  v_sev := case when v_kind in ('checkout_error', 'login_error', 'auth_error') then 'high'
                when v_kind in ('api_error', 'network_error') then 'medium'
                else 'low' end;
  v_id := public.ops_signal(v_fp, 'frontend', v_sev, v_app || ' app', initcap(replace(v_kind, '_', ' ')) || ' in the ' || v_app || ' app',
                            v_msg, jsonb_build_object('last_route', v_route, 'last_context', v_ctx), 'frontend', 1);
  insert into public.ops_events (incident_id, source, fingerprint, category, message, context, app, route, correlation_id)
  values (v_id, 'frontend', v_fp, v_kind, v_msg, v_ctx, v_app, v_route, left(regexp_replace(coalesce(p_correlation, ''), '[^A-Za-z0-9-]', '', 'g'), 40));
  -- keep up to 20 correlation ids per incident
  update public.ops_incidents set correlation_ids = correlation_ids || left(regexp_replace(coalesce(p_correlation, ''), '[^A-Za-z0-9-]', '', 'g'), 40)
   where id = v_id and left(regexp_replace(coalesce(p_correlation, ''), '[^A-Za-z0-9-]', '', 'g'), 40) <> ''
     and not (left(regexp_replace(coalesce(p_correlation, ''), '[^A-Za-z0-9-]', '', 'g'), 40) = any (correlation_ids))
     and coalesce(array_length(correlation_ids, 1), 0) < 20;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- 7. the scheduled checks ----------
create or replace function public.ops_run_checks()
returns int language plpgsql security definer set search_path = public, cron, net as $$
declare
  s public.ops_settings;
  t jsonb;
  n int; n2 int; n3 int;
  v_seen text[] := '{}';
  v_found int := 0;
  r record;
  v_ev jsonb;
  v_start timestamptz := clock_timestamp();
begin
  select * into s from public.ops_settings where id = 1;
  t := s.thresholds;

  -- notifications that died
  select count(*) into n from public.notification_jobs where status = 'dead' and failed_at > now() - interval '6 hours';
  if n > 0 then
    select jsonb_build_object('dead_jobs_6h', n, 'by_channel', (select jsonb_object_agg(channel, c) from (select channel, count(*) c from public.notification_jobs where status = 'dead' and failed_at > now() - interval '6 hours' group by channel) x),
                              'sample_errors', (select jsonb_agg(distinct public.ops_redact(left(error, 120))) from (select error from public.notification_jobs where status = 'dead' and failed_at > now() - interval '6 hours' limit 5) y))
      into v_ev;
    perform public.ops_signal('notifications:dead', 'notifications', case when n >= 10 then 'high' else 'medium' end, 'Notification queue',
      'Notifications could not be delivered', n || ' notification job(s) gave up after 5 tries in the last 6 hours.', v_ev);
    v_seen := array_append(v_seen, 'notifications:dead'); v_found := v_found + 1;
  end if;

  -- emails that failed
  select count(*) into n from public.email_outbox where status in ('failed', 'bounced') and coalesce(updated_at, created_at) > now() - interval '6 hours';
  if n > 0 then
    select jsonb_build_object('failed_emails_6h', n, 'by_kind', (select jsonb_object_agg(kind, c) from (select kind, count(*) c from public.email_outbox where status in ('failed', 'bounced') and coalesce(updated_at, created_at) > now() - interval '6 hours' group by kind) x))
      into v_ev;
    perform public.ops_signal('email:failed', 'email', 'medium', 'Email (Resend)', 'Emails failed to send', n || ' email(s) failed or bounced in the last 6 hours.', v_ev);
    v_seen := array_append(v_seen, 'email:failed'); v_found := v_found + 1;
  end if;

  -- scheduled jobs that failed
  for r in select j.jobname, count(*) c, max(d.end_time) last_fail, left(max(d.return_message), 150) msg
             from cron.job_run_details d join cron.job j on j.jobid = d.jobid
            where d.status = 'failed' and d.start_time > now() - interval '30 minutes'
              and j.jobname not like 'ops-%'
            group by j.jobname loop
    perform public.ops_signal('jobs:failed:' || r.jobname, 'scheduled_jobs', 'high', 'Scheduled job ' || r.jobname,
      'Scheduled job "' || r.jobname || '" is failing', r.c || ' failed run(s) in the last 30 minutes.',
      jsonb_build_object('job', r.jobname, 'failed_runs_30m', r.c, 'last_failure', r.last_fail, 'message', public.ops_redact(r.msg)));
    v_seen := array_append(v_seen, ('jobs:failed:' || r.jobname)); v_found := v_found + 1;
  end loop;

  -- server-to-server calls (pg_net: notification worker, email sender, AI worker)
  select count(*) into n from net._http_response where created > now() - interval '30 minutes' and (status_code >= 500 or error_msg is not null or timed_out);
  if n >= coalesce((t->>'server_call_errors_30m')::int, 3) then
    perform public.ops_signal('server_calls:failed', 'server_calls', 'high', 'Server functions (called by the database)',
      'Calls to server functions are failing', n || ' call(s) from the database to server functions failed in the last 30 minutes.',
      jsonb_build_object('failed_calls_30m', n, 'by_status', (select jsonb_object_agg(coalesce(status_code::text, 'no response'), c) from (select status_code, count(*) c from net._http_response where created > now() - interval '30 minutes' and (status_code >= 500 or error_msg is not null or timed_out) group by status_code) x)));
    v_seen := array_append(v_seen, 'server_calls:failed'); v_found := v_found + 1;
  end if;

  -- errors inside the order notification trigger
  select count(*) into n from public.notification_errors where created_at > now() - interval '6 hours';
  if n > 0 then
    perform public.ops_signal('notifications:trigger_errors', 'database', 'high', 'Order notification trigger',
      'The order notification trigger hit errors', n || ' error(s) in the last 6 hours (orders still went through).',
      jsonb_build_object('errors_6h', n, 'sample', (select jsonb_agg(distinct public.ops_redact(left(error, 150))) from (select error from public.notification_errors where created_at > now() - interval '6 hours' limit 5) y)));
    v_seen := array_append(v_seen, 'notifications:trigger_errors'); v_found := v_found + 1;
  end if;

  -- orders stuck in received/preparing past the threshold (student orders count
  -- from their chosen collection time, not from when they were placed)
  select count(*) into n from public.orders o
   where o.status in ('received', 'preparing') and o.created_at > now() - interval '2 days'
     and coalesce(nullif(o.delivery_location->>'collectionTime', '')::timestamptz, o.created_at)
         < now() - make_interval(mins => coalesce((t->>'stuck_order_minutes')::int, 120));
  if n > 0 then
    select jsonb_build_object('stuck_orders', n,
      'by_status', (select jsonb_object_agg(status, c) from (select status, count(*) c from public.orders o where o.status in ('received', 'preparing') and o.created_at > now() - interval '2 days'
                     and coalesce(nullif(o.delivery_location->>'collectionTime', '')::timestamptz, o.created_at) < now() - make_interval(mins => coalesce((t->>'stuck_order_minutes')::int, 120)) group by status) x),
      'shops', (select count(distinct store_id) from public.orders o where o.status in ('received', 'preparing') and o.created_at > now() - interval '2 days'
                 and coalesce(nullif(o.delivery_location->>'collectionTime', '')::timestamptz, o.created_at) < now() - make_interval(mins => coalesce((t->>'stuck_order_minutes')::int, 120))),
      'threshold_minutes', coalesce((t->>'stuck_order_minutes')::int, 120))
      into v_ev;
    perform public.ops_signal('orders:stuck', 'orders', case when n >= 5 then 'high' else 'medium' end, 'Order flow',
      'Orders are not moving', n || ' order(s) have stayed received or preparing longer than expected.', v_ev);
    v_seen := array_append(v_seen, 'orders:stuck'); v_found := v_found + 1;
  end if;

  -- a card payment that went through but has no order
  select count(*) into n from public.checkout_sessions
   where status = 'paid' and group_id is null and coalesce(jsonb_array_length(order_ids), 0) = 0
     and updated_at < now() - interval '10 minutes' and updated_at > now() - interval '7 days';
  if n > 0 then
    perform public.ops_signal('payments:paid_without_order', 'payments', 'critical', 'Card payments (PayFast)',
      'A paid checkout has no order', n || ' checkout(s) are marked paid by PayFast but no order was created.',
      jsonb_build_object('paid_sessions_without_order', n, 'note', 'Compare with the PayFast record before changing anything.'));
    v_seen := array_append(v_seen, 'payments:paid_without_order'); v_found := v_found + 1;
  end if;

  -- second payments for the same order, not yet refunded
  select count(*) into n from public.payment_duplicates where coalesce(status, '') <> 'refunded' and created_at > now() - interval '7 days';
  if n > 0 then
    perform public.ops_signal('payments:duplicates', 'payments', 'high', 'Card payments (PayFast)',
      'Customers paid twice for the same order', n || ' duplicate payment(s) in the last 7 days are not refunded yet.',
      jsonb_build_object('duplicates_7d', n, 'by_status', (select jsonb_object_agg(coalesce(status, 'unknown'), c) from (select status, count(*) c from public.payment_duplicates where coalesce(status, '') <> 'refunded' and created_at > now() - interval '7 days' group by status) x)));
    v_seen := array_append(v_seen, 'payments:duplicates'); v_found := v_found + 1;
  end if;

  -- payment notices with bad signatures (forged or misconfigured)
  select count(*) into n from public.payment_events where event_type like '%invalid_signature%' and created_at > now() - interval '1 hour';
  if n >= coalesce((t->>'invalid_signatures_1h')::int, 3) then
    perform public.ops_signal('security:payment_signatures', 'security', 'high', 'PayFast notifications',
      'Payment notices with invalid signatures', n || ' payment notice(s) with an invalid signature in the last hour.',
      jsonb_build_object('invalid_signatures_1h', n));
    v_seen := array_append(v_seen, 'security:payment_signatures'); v_found := v_found + 1;
  end if;

  -- failed logins (secure-login keeps per-email counters)
  select coalesce(sum(failed_count), 0), count(*), count(*) filter (where locked_until > now())
    into n, n2, n3 from public.login_attempts where updated_at > now() - interval '15 minutes' and failed_count > 0;
  if n >= coalesce((t->>'login_failures_15m')::int, 20) or n3 >= 3 then
    perform public.ops_signal('security:login_failures', 'security', 'high', 'Login',
      case when n2 >= 10 then 'Many accounts are getting failed logins' else 'Many failed logins' end,
      n || ' failed login(s) across ' || n2 || ' account(s) in 15 minutes; ' || n3 || ' account(s) locked.',
      jsonb_build_object('failed_logins_15m', n, 'accounts', n2, 'locked_accounts', n3,
                         'pattern', case when n2 >= 10 then 'many accounts (password guessing across accounts suspected)' else 'few accounts' end));
    v_seen := array_append(v_seen, 'security:login_failures'); v_found := v_found + 1;
  end if;

  -- sign-up bursts (many new accounts, possibly with different emails)
  select count(*), count(*) filter (where email_confirmed_at is null) into n, n2 from auth.users where created_at > now() - interval '10 minutes';
  if n >= coalesce((t->>'signups_10m')::int, 40) then
    perform public.ops_signal('security:signup_burst', 'security', 'high', 'Sign-up',
      'Unusual number of sign-ups', n || ' new account(s) in 10 minutes (' || n2 || ' not confirmed).',
      jsonb_build_object('signups_10m', n, 'unconfirmed', n2, 'threshold', coalesce((t->>'signups_10m')::int, 40),
        'domains', (select jsonb_object_agg(d, c) from (select split_part(lower(email), '@', 2) d, count(*) c from auth.users where created_at > now() - interval '10 minutes' group by 1 order by 2 desc limit 5) x)));
    v_seen := array_append(v_seen, 'security:signup_burst'); v_found := v_found + 1;
  end if;

  -- rate-limit violations and blocks per endpoint; many sources = coordinated
  for r in select endpoint, count(*) filter (where kind = 'rate_limited') violations, count(*) filter (where kind = 'blocked') blocks, count(distinct key) sources
             from public.security_events where created_at > now() - interval '15 minutes' and kind in ('rate_limited', 'blocked')
            group by endpoint loop
    perform public.ops_signal('security:rate_limits:' || r.endpoint, 'security',
      case when r.sources >= coalesce((t->>'coordinated_sources')::int, 5) or r.blocks > 0 then 'high' else 'medium' end,
      'Rate limits (' || r.endpoint || ')',
      case when r.sources >= coalesce((t->>'coordinated_sources')::int, 5) then 'Coordinated traffic suspected on ' || r.endpoint else 'Rate limit hits on ' || r.endpoint end,
      r.violations || ' limit violation(s) and ' || r.blocks || ' temporary block(s) from ' || r.sources || ' source(s) in 15 minutes.',
      jsonb_build_object('endpoint', r.endpoint, 'violations_15m', r.violations, 'blocks_15m', r.blocks, 'distinct_sources', r.sources,
                         'classification', case when r.sources >= coalesce((t->>'coordinated_sources')::int, 5) then 'suspected coordinated (many sources)' else 'confirmed limit violation' end));
    v_seen := array_append(v_seen, ('security:rate_limits:' || r.endpoint)); v_found := v_found + 1;
  end loop;

  -- problems no longer found: after 2 clean runs in a row the incident is
  -- resolved, unless a recovery is still waiting or being checked
  update public.ops_incidents set clear_runs = clear_runs + 1, updated_at = now()
   where source in ('check', 'security') and status <> 'resolved' and not (fingerprint = any (v_seen));
  for r in select id from public.ops_incidents
            where source in ('check', 'security') and status <> 'resolved' and clear_runs >= 2
              and recovery_status not in ('awaiting_approval', 'running', 'verifying') loop
    update public.ops_incidents set status = 'resolved', resolved_at = now(),
           resolution = 'The checks no longer find the problem (2 clean runs in a row).', updated_at = now()
     where id = r.id;
    perform public.ops_audit_add(r.id, 'system', null, 'resolved', 'condition cleared', '{}'::jsonb);
  end loop;
  -- app errors that stopped for 24 hours
  for r in select id from public.ops_incidents
            where source = 'frontend' and status <> 'resolved' and last_seen < now() - interval '24 hours'
              and recovery_status not in ('awaiting_approval', 'running', 'verifying') loop
    update public.ops_incidents set status = 'resolved', resolved_at = now(),
           resolution = 'The error has not happened again for 24 hours.', updated_at = now()
     where id = r.id;
    perform public.ops_audit_add(r.id, 'system', null, 'resolved', 'no recurrence 24h', '{}'::jsonb);
  end loop;

  insert into public.ops_check_runs (ok, findings, duration_ms) values (true, v_found, (extract(epoch from clock_timestamp() - v_start) * 1000)::int);
  return v_found;
exception when others then
  -- the monitor itself failed: recorded (not as a looping incident)
  insert into public.ops_check_runs (ok, findings, error) values (false, 0, left(sqlerrm, 300));
  return -1;
end $$;

-- ---------- 8. recovery: request, approve, execute, verify ----------
create or replace function public.ops_execute_attempt(p_attempt uuid)
returns void language plpgsql security definer set search_path = public as $$
declare a public.ops_recovery_attempts; ids uuid[]; v_n int;
begin
  select * into a from public.ops_recovery_attempts where id = p_attempt for update;
  if not found or a.status <> 'approved' then return; end if;
  if (select risk from public.ops_actions where id = a.action_id) <> 'low' then
    update public.ops_recovery_attempts set status = 'approved_manual', finished_at = now(),
           authorization_note = 'High-risk action: approved for a person to carry out. The system does not run it.'
     where id = a.id;
    update public.ops_incidents set recovery_status = 'manual', updated_at = now() where id = a.incident_id;
    return;
  end if;
  update public.ops_recovery_attempts set status = 'running', started_at = now() where id = a.id;
  update public.ops_incidents set status = 'recovery_in_progress', recovery_status = 'running', updated_at = now() where id = a.incident_id;
  begin
    if a.action_id = 'retry_dead_notifications' then
      with x as (
        update public.notification_jobs set status = 'queued', next_attempt_at = now(), attempts = 4, locked_at = null,
               error = left(coalesce(error, '') || ' | retried by monitoring', 500)
         where id in (select id from public.notification_jobs where status = 'dead' and failed_at > now() - interval '24 hours' limit 200)
        returning id)
      select array_agg(id) into ids from x;
      perform public.kick_notification_worker();
    elsif a.action_id = 'retry_failed_emails' then
      with x as (
        update public.email_outbox set status = 'queued', attempts = least(coalesce(attempts, 0), 2), updated_at = now()
         where id in (select id from public.email_outbox where status = 'failed' and coalesce(updated_at, created_at) > now() - interval '24 hours' limit 50)
        returning id)
      select array_agg(id) into ids from x;
      perform public.dispatch_email(i) from unnest(coalesce(ids, '{}')) i;
    elsif a.action_id = 'kick_notification_worker' then
      perform public.kick_notification_worker();
    elsif a.action_id = 'rerun_collection_expiry' then
      perform public.expire_collection_windows();
    elsif a.action_id = 'rerun_diagnostics' then
      perform public.ops_run_checks();
    end if;
    v_n := coalesce(array_length(ids, 1), 0);
    update public.ops_recovery_attempts set status = 'verifying', finished_at = now(),
           input = input || jsonb_build_object('affected', v_n, 'ids', coalesce(to_jsonb(ids), '[]'::jsonb)),
           verify_after = now() + interval '90 seconds', verify_deadline = now() + interval '10 minutes'
     where id = a.id;
    update public.ops_incidents set status = 'verification_in_progress', recovery_status = 'verifying', updated_at = now() where id = a.incident_id;
    perform public.ops_audit_add(a.incident_id, 'system', null, 'action_run', a.action_id, jsonb_build_object('affected', v_n));
  exception when others then
    update public.ops_recovery_attempts set status = 'failed', finished_at = now(), failure = left(sqlerrm, 300), verification_passed = false where id = a.id;
    update public.ops_incidents set status = 'recovery_failed', recovery_status = 'failed', updated_at = now() where id = a.incident_id;
    perform public.ops_audit_add(a.incident_id, 'system', null, 'action_run', 'failed', jsonb_build_object('action', a.action_id, 'error', left(sqlerrm, 200)));
    perform public.ops_alert(a.incident_id, 'Recovery failed');
  end;
end $$;

-- Decides what happens to a proposed action. The AI and the assistant can
-- only PROPOSE; only the policy (low risk + auto mode + AI source) or a
-- developer can let it run, and high-risk actions are never run by the system.
create or replace function public.ops_request_recovery(p_incident uuid, p_action text, p_source text, p_reason text, p_user uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  act public.ops_actions;
  s public.ops_settings;
  v_id uuid;
  v_done int;
  v_status text;
  v_note text;
begin
  select * into act from public.ops_actions where id = p_action;
  if not found then
    perform public.ops_audit_add(p_incident, case when p_source in ('ai', 'assistant', 'developer', 'system') then p_source else 'unknown' end, p_user,
                                 'action_refused', 'unknown action', jsonb_build_object('action', left(coalesce(p_action, ''), 60)));
    return null;
  end if;
  select id into v_id from public.ops_recovery_attempts
   where incident_id = p_incident and action_id = p_action and status in ('awaiting_approval', 'approved', 'running', 'verifying');
  if found then return v_id; end if;   -- already in progress: no duplicate
  select count(*) into v_done from public.ops_recovery_attempts
   where incident_id = p_incident and action_id = p_action and status in ('succeeded', 'failed', 'verifying');
  select * into s from public.ops_settings where id = 1;

  if act.risk = 'low' and v_done >= 2 then
    v_status := 'skipped'; v_note := 'Retry limit reached (2 runs of this action for this incident).';
  elsif act.risk = 'low' and p_source = 'developer' and p_user is not null and public.ops_has_perm(p_user, 'approve') then
    v_status := 'approved'; v_note := 'Run by a developer.';
  elsif act.risk = 'low' and act.auto_allowed and s.mode = 'auto_recovery' and p_source in ('ai', 'system') then
    v_status := 'approved'; v_note := 'Allowed by policy: low risk, automatic recovery is on.';
  else
    v_status := 'awaiting_approval';
    v_note := case when act.risk = 'high' then 'High risk: needs a developer''s approval, and a person carries it out.'
                   when s.mode = 'monitoring_only' then 'Monitoring-only mode: needs a developer''s approval.'
                   else 'Needs a developer''s approval.' end;
  end if;

  insert into public.ops_recovery_attempts (incident_id, action_id, requested_by, requested_by_user, reason, status, authorization_note,
                                           approved_by, approved_at)
  values (p_incident, p_action, p_source, p_user, left(public.ops_redact(p_reason), 600), v_status, v_note,
          case when v_status = 'approved' and p_source = 'developer' then p_user end, case when v_status = 'approved' then now() end)
  returning id into v_id;
  perform public.ops_audit_add(p_incident, p_source, p_user, 'action_proposed', v_status, jsonb_build_object('action', p_action, 'risk', act.risk));

  if v_status = 'awaiting_approval' then
    update public.ops_incidents set status = case when status in ('resolved') then status else 'awaiting_approval' end,
           recovery_status = 'awaiting_approval', updated_at = now() where id = p_incident;
    perform public.ops_alert(p_incident, 'Approval needed: ' || act.label);
  elsif v_status = 'approved' then
    perform public.ops_execute_attempt(v_id);
  end if;
  return v_id;
end $$;

-- Checks every finished action against real records, not against what the
-- action itself reported.
create or replace function public.ops_verify_attempts()
returns int language plpgsql security definer set search_path = public as $$
declare a record; v_pass boolean; v_detail jsonb; n int; n2 int; v_ids uuid[]; v_done int := 0; v_inc public.ops_incidents;
begin
  for a in select * from public.ops_recovery_attempts where status = 'verifying' and verify_after <= now() for update skip locked loop
    v_pass := null;
    v_ids := array(select (jsonb_array_elements_text(coalesce(a.input->'ids', '[]'::jsonb)))::uuid);
    if a.action_id = 'retry_dead_notifications' then
      select count(*) filter (where status in ('sent', 'delivered', 'skipped')), count(*) filter (where status in ('dead', 'failed'))
        into n, n2 from public.notification_jobs where id = any (v_ids);
      v_detail := jsonb_build_object('retried', coalesce(array_length(v_ids, 1), 0), 'delivered', n, 'failed_again', n2);
      if n = coalesce(array_length(v_ids, 1), 0) then v_pass := true; elsif n2 > 0 or now() > a.verify_deadline then v_pass := false; end if;
    elsif a.action_id = 'retry_failed_emails' then
      select count(*) filter (where status in ('sent', 'delivered')), count(*) filter (where status in ('failed', 'bounced'))
        into n, n2 from public.email_outbox where id = any (v_ids);
      v_detail := jsonb_build_object('retried', coalesce(array_length(v_ids, 1), 0), 'sent', n, 'failed_again', n2);
      if n = coalesce(array_length(v_ids, 1), 0) then v_pass := true; elsif n2 > 0 or now() > a.verify_deadline then v_pass := false; end if;
    elsif a.action_id = 'kick_notification_worker' then
      select count(*) into n from public.notification_jobs where status in ('queued', 'failed') and next_attempt_at < now() - interval '2 minutes';
      v_detail := jsonb_build_object('jobs_waiting_over_2_min', n);
      v_pass := n = 0;
    elsif a.action_id = 'rerun_collection_expiry' then
      select count(*) into n from public.orders where status = 'ready' and collection_state = 'window' and collection_deadline < now() - interval '5 minutes';
      v_detail := jsonb_build_object('orders_past_deadline_unhandled', n);
      v_pass := n = 0;
    elsif a.action_id = 'rerun_diagnostics' then
      select * into v_inc from public.ops_incidents where id = a.incident_id;
      v_detail := jsonb_build_object('problem_still_detected', v_inc.clear_runs = 0 and v_inc.last_seen > a.finished_at);
      v_pass := not (v_inc.clear_runs = 0 and v_inc.last_seen > a.finished_at);
    end if;
    continue when v_pass is null;   -- not decided yet (still within the deadline)

    update public.ops_recovery_attempts set status = case when v_pass then 'succeeded' else 'failed' end,
           verification = v_detail, verification_passed = v_pass,
           failure = case when v_pass then null else 'Verification failed: the problem is still there.' end
     where id = a.id;
    if v_pass then
      -- worked: keep watching; it is resolved only when the checks stay clean
      update public.ops_incidents set status = 'monitoring', recovery_status = 'verified', updated_at = now() where id = a.incident_id and status <> 'resolved';
      perform public.ops_audit_add(a.incident_id, 'system', null, 'verified', 'passed', v_detail);
    else
      update public.ops_incidents set status = 'recovery_failed', recovery_status = 'verification_failed', updated_at = now() where id = a.incident_id;
      perform public.ops_audit_add(a.incident_id, 'system', null, 'verified', 'failed', v_detail);
      perform public.ops_alert(a.incident_id, 'Recovery did not fix it');
    end if;
    v_done := v_done + 1;
  end loop;
  return v_done;
end $$;

-- ---------- 9. AI investigation queue (used by the ops-investigate function) ----------
create or replace function public.ops_kick_investigator()
returns void language plpgsql security definer set search_path = public, net as $$
declare c public.ops_function_config;
begin
  select * into c from public.ops_function_config where id = 1;
  if not found then return; end if;
  perform net.http_post(url := c.investigate_url, body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-ops-secret', c.secret), timeout_milliseconds := 10000);
end $$;

-- Reserves AI budget for up to p_limit queued incidents; over the daily limit
-- they are marked skipped_limit (a developer can re-run them later).
create or replace function public.ops_claim_investigations(p_limit int default 3)
returns setof public.ops_incidents language plpgsql security definer set search_path = public as $$
declare s public.ops_settings; v_used int; r public.ops_incidents;
begin
  select * into s from public.ops_settings where id = 1;
  if not s.ai_enabled then
    update public.ops_incidents set ai_status = 'skipped_disabled', updated_at = now() where ai_status = 'queued';
    return;
  end if;
  for r in select * from public.ops_incidents where ai_status = 'queued' order by public.ops_sev_rank(severity) desc, detected_at
            limit greatest(1, least(p_limit, 10)) for update skip locked loop
    select coalesce(calls, 0) into v_used from public.ops_ai_usage where day = current_date and kind = 'investigation';
    if coalesce(v_used, 0) >= s.ai_daily_limit then
      update public.ops_incidents set ai_status = 'skipped_limit', updated_at = now() where id = r.id;
      perform public.ops_audit_add(r.id, 'system', null, 'ai_skipped', 'daily limit reached', jsonb_build_object('limit', s.ai_daily_limit));
      continue;
    end if;
    insert into public.ops_ai_usage (day, kind, calls) values (current_date, 'investigation', 1)
    on conflict (day, kind) do update set calls = public.ops_ai_usage.calls + 1;
    update public.ops_incidents set ai_status = 'running', status = case when status in ('detected') then 'investigating' else status end,
           investigation_started_at = now(), updated_at = now()
     where id = r.id returning * into r;
    return next r;
  end loop;
end $$;

-- The ONLY thing the AI is shown: the incident, its aggregated (already
-- redacted) evidence, recent redacted error messages, earlier report summaries
-- and the list of actions that exist. No customer, staff or payment records.
create or replace function public.ops_incident_evidence(p_incident uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'incident', jsonb_build_object('ref', i.ref, 'category', i.category, 'severity', i.severity, 'service', i.service, 'title', i.title,
                                   'summary', i.summary, 'status', i.status, 'occurrences', i.occurrences, 'first_seen', i.first_seen,
                                   'last_seen', i.last_seen, 'is_recurrence', i.recurrence_of is not null),
    'evidence', i.evidence,
    'recent_events', coalesce((select jsonb_agg(jsonb_build_object('at', e.created_at, 'kind', e.category, 'app', e.app, 'route', e.route,
                                                                  'message', public.ops_redact(e.message), 'context', e.context) order by e.created_at desc)
                               from (select * from public.ops_events where incident_id = i.id order by created_at desc limit 15) e), '[]'::jsonb),
    'earlier_reports', coalesce((select jsonb_agg(jsonb_build_object('version', r.version, 'status', r.status, 'root_cause', r.report->>'root_cause',
                                                                    'confidence', r.report->>'confidence', 'action', r.recommended_action) order by r.version desc)
                                 from (select * from public.ops_reports where incident_id = i.id order by version desc limit 2) r), '[]'::jsonb),
    'earlier_actions', coalesce((select jsonb_agg(jsonb_build_object('action', a.action_id, 'status', a.status, 'verified', a.verification_passed, 'verification', a.verification))
                                 from public.ops_recovery_attempts a where a.incident_id = i.id), '[]'::jsonb),
    'available_actions', (select jsonb_agg(jsonb_build_object('id', id, 'label', label, 'risk', risk, 'what_it_does', description) order by risk, id) from public.ops_actions),
    'mode', (select mode from public.ops_settings where id = 1))
  from public.ops_incidents i where i.id = p_incident
$$;

-- Saves a report. The structure was validated by the function; here the
-- recommended action is checked against the registry once more, and the
-- decision about running it is made by ops_request_recovery, not by the AI.
create or replace function public.ops_save_report(p_incident uuid, p_ok boolean, p_report jsonb, p_model text, p_in int, p_out int, p_error text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_ver int; v_action text; v_cost numeric; s public.ops_settings;
begin
  select * into s from public.ops_settings where id = 1;
  select coalesce(max(version), 0) + 1 into v_ver from public.ops_reports where incident_id = p_incident;
  v_cost := round((coalesce(p_in, 0) * s.ai_price_in_per_mtok + coalesce(p_out, 0) * s.ai_price_out_per_mtok) / 1000000.0, 6);
  update public.ops_ai_usage set input_tokens = input_tokens + coalesce(p_in, 0), output_tokens = output_tokens + coalesce(p_out, 0), cost_usd = cost_usd + v_cost
   where day = current_date and kind = 'investigation';
  if not p_ok then
    insert into public.ops_reports (incident_id, version, status, model, error, input_tokens, output_tokens, cost_usd)
    values (p_incident, v_ver, 'failed', p_model, left(public.ops_redact(p_error), 500), p_in, p_out, v_cost) returning id into v_id;
    update public.ops_incidents set ai_status = 'failed', investigation_completed_at = now(),
           status = case when status = 'investigating' then 'detected' else status end, updated_at = now() where id = p_incident;
    perform public.ops_audit_add(p_incident, 'ai', null, 'investigation', 'failed', jsonb_build_object('error', left(public.ops_redact(p_error), 200)));
    return v_id;
  end if;
  v_action := p_report->'recommended_action'->>'action_id';
  if v_action is not null and v_action <> 'none' and not exists (select 1 from public.ops_actions where id = v_action) then
    p_report := jsonb_set(p_report, '{recommended_action,action_id}', '"none"') || jsonb_build_object('note', 'The AI suggested an action that does not exist; it was ignored.');
    v_action := 'none';
  end if;
  insert into public.ops_reports (incident_id, version, status, model, report, recommended_action, input_tokens, output_tokens, cost_usd)
  values (p_incident, v_ver, 'complete', p_model, p_report, coalesce(v_action, 'none'), p_in, p_out, v_cost) returning id into v_id;
  update public.ops_incidents set ai_status = 'complete', investigation_completed_at = now(),
         status = case when status in ('detected', 'investigating') then 'analysis_complete' else status end, updated_at = now()
   where id = p_incident;
  perform public.ops_audit_add(p_incident, 'ai', null, 'investigation', 'complete', jsonb_build_object('version', v_ver, 'action', v_action));
  if coalesce(v_action, 'none') <> 'none' then
    perform public.ops_request_recovery(p_incident, v_action, 'ai', p_report->'recommended_action'->>'reason');
  end if;
  return v_id;
end $$;

-- ---------- 10. developer actions (server-side permission checks; refusals are recorded) ----------
create or replace function public.ops_dev(p_action text, p_incident uuid default null, p_arg jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_perm text := case when p_action in ('approve', 'reject', 'run_action', 'settings') then 'approve' else 'view' end;
  a public.ops_recovery_attempts;
  v_id uuid;
  s jsonb;
begin
  if v_uid is null or not public.ops_has_perm(v_uid, v_perm) then
    insert into public.security_events (kind, key, endpoint, detail) values ('unauthorized', 'acct:' || coalesce(v_uid::text, 'anon'), 'ops_dev', jsonb_build_object('action', left(coalesce(p_action, ''), 40)));
    return jsonb_build_object('ok', false, 'error', 'Not allowed.');
  end if;
  if p_action = 'approve' or p_action = 'reject' then
    select * into a from public.ops_recovery_attempts where id = (p_arg->>'attempt_id')::uuid for update;
    if not found or a.status <> 'awaiting_approval' then return jsonb_build_object('ok', false, 'error', 'This action is not waiting for approval.'); end if;
    if p_action = 'reject' then
      update public.ops_recovery_attempts set status = 'rejected', approved_by = v_uid, approved_at = now() where id = a.id;
      update public.ops_incidents set recovery_status = 'rejected', status = case when status = 'awaiting_approval' then 'unresolved' else status end, updated_at = now() where id = a.incident_id;
      perform public.ops_audit_add(a.incident_id, 'developer', v_uid, 'rejected', a.action_id, '{}'::jsonb);
    else
      update public.ops_recovery_attempts set status = 'approved', approved_by = v_uid, approved_at = now() where id = a.id;
      update public.ops_incidents set recovery_status = 'approved', updated_at = now() where id = a.incident_id;
      perform public.ops_audit_add(a.incident_id, 'developer', v_uid, 'approved', a.action_id, '{}'::jsonb);
      perform public.ops_execute_attempt(a.id);
    end if;
    return jsonb_build_object('ok', true);
  elsif p_action = 'run_action' then
    v_id := public.ops_request_recovery(p_incident, p_arg->>'action_id', 'developer', 'Run by a developer from the dashboard', v_uid);
    return jsonb_build_object('ok', v_id is not null, 'attempt_id', v_id);
  elsif p_action = 'review' then
    update public.ops_incidents set reviewed = true, reviewed_by = v_uid, reviewed_at = now(), updated_at = now() where id = p_incident;
    perform public.ops_audit_add(p_incident, 'developer', v_uid, 'reviewed', null, '{}'::jsonb);
    return jsonb_build_object('ok', true);
  elsif p_action = 'note' then
    perform public.ops_audit_add(p_incident, 'developer', v_uid, 'note', null, jsonb_build_object('note', left(public.ops_redact(p_arg->>'note'), 1000)));
    return jsonb_build_object('ok', true);
  elsif p_action = 'reinvestigate' then
    update public.ops_incidents set ai_status = 'queued', updated_at = now() where id = p_incident and ai_status not in ('queued', 'running');
    perform public.ops_audit_add(p_incident, 'developer', v_uid, 'reinvestigate', null, '{}'::jsonb);
    perform public.ops_kick_investigator();
    return jsonb_build_object('ok', true);
  elsif p_action = 'run_checks' then
    return jsonb_build_object('ok', true, 'findings', public.ops_run_checks());
  elsif p_action = 'settings' then
    s := p_arg;
    update public.ops_settings set
      mode = coalesce(case when s->>'mode' in ('monitoring_only', 'auto_recovery') then s->>'mode' end, mode),
      ai_enabled = case when s->>'ai_enabled' in ('true', 'false') then (s->>'ai_enabled')::boolean else ai_enabled end,
      ai_daily_limit = case when (s->>'ai_daily_limit') ~ '^[0-9]+$' then least((s->>'ai_daily_limit')::int, 500) else ai_daily_limit end,
      assistant_daily_limit = case when (s->>'assistant_daily_limit') ~ '^[0-9]+$' then least((s->>'assistant_daily_limit')::int, 2000) else assistant_daily_limit end,
      ai_min_severity = coalesce(case when s->>'ai_min_severity' in ('informational', 'low', 'medium', 'high', 'critical') then s->>'ai_min_severity' end, ai_min_severity),
      alert_min_severity = coalesce(case when s->>'alert_min_severity' in ('informational', 'low', 'medium', 'high', 'critical') then s->>'alert_min_severity' end, alert_min_severity),
      thresholds = case when jsonb_typeof(s->'thresholds') = 'object' then thresholds || (select jsonb_object_agg(k, to_jsonb(least(greatest((v #>> '{}')::int, 1), 100000)))
                                                                                         from jsonb_each(s->'thresholds') e(k, v) where k in (select jsonb_object_keys(thresholds) from public.ops_settings where id = 1) and (v #>> '{}') ~ '^[0-9]+$')
                        else thresholds end,
      retention_days = case when (s->>'retention_days') ~ '^[0-9]+$' then least(greatest((s->>'retention_days')::int, 7), 730) else retention_days end,
      updated_at = now(), updated_by = v_uid
     where id = 1;
    perform public.ops_audit_add(null, 'developer', v_uid, 'settings_changed', coalesce(s->>'mode', 'settings'), s - 'thresholds' || jsonb_build_object('thresholds_changed', s ? 'thresholds'));
    return jsonb_build_object('ok', true);
  end if;
  return jsonb_build_object('ok', false, 'error', 'Unknown action.');
end $$;

-- ---------- 11. AI Developer Assistant: conversations + tools ----------
create table if not exists public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  developer_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default 'New conversation',
  incident_id uuid references public.ops_incidents(id) on delete set null,
  summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_conversations_dev on public.ai_conversations (developer_id, updated_at desc);
create table if not exists public.ai_messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool')),
  content text not null default '',
  via_voice boolean not null default false,
  tool_name text,
  tool_input jsonb,
  tool_result jsonb,
  attempt_id uuid references public.ops_recovery_attempts(id) on delete set null,
  input_tokens int,
  output_tokens int,
  created_at timestamptz not null default now()
);
create index if not exists ai_messages_conv on public.ai_messages (conversation_id, id);

-- The assistant's tools. Each one is an allow-listed, read-only query over
-- aggregated or already-redacted data, checked against the developer's
-- permission on every call. Nothing here returns customer/staff names,
-- emails, phones, addresses, passwords, tokens, keys or payment details.
-- login totals for the assistant, only if login protection is installed
create or replace function public.ops_login_totals(p_hours int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if to_regprocedure('public.login_report_internal(integer)') is null then return null; end if;
  execute 'select public.login_report_internal($1)->''totals''' into r using p_hours;
  return r;
end $$;
revoke all on function public.ops_login_totals(int) from public, anon, authenticated;

create or replace function public.ops_tool(p_developer uuid, p_tool text, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = public, cron as $$
declare
  v_hours int := least(greatest(coalesce((p_args->>'hours')::int, 24), 1), 720);
  v_lim int := least(greatest(coalesce((p_args->>'limit')::int, 10), 1), 25);
  i public.ops_incidents;
  v_id uuid;
begin
  if not public.ops_has_perm(p_developer, 'chat') then
    insert into public.security_events (kind, key, endpoint, detail) values ('unauthorized', 'acct:' || coalesce(p_developer::text, 'none'), 'ops_tool', jsonb_build_object('tool', left(coalesce(p_tool, ''), 40)));
    return jsonb_build_object('error', 'Not allowed.');
  end if;
  if p_tool = 'system_overview' then
    return jsonb_build_object(
      'window_hours', v_hours,
      'mode', (select mode from public.ops_settings where id = 1),
      'last_check', (select jsonb_build_object('at', ran_at, 'ok', ok, 'findings', findings) from public.ops_check_runs order by ran_at desc limit 1),
      'last_successful_check', (select max(ran_at) from public.ops_check_runs where ok),
      'incidents_by_severity', (select jsonb_object_agg(severity, c) from (select severity, count(*) c from public.ops_incidents where detected_at > now() - make_interval(hours => v_hours) group by severity) x),
      'open_incidents', (select count(*) from public.ops_incidents where status <> 'resolved'),
      'awaiting_approval', (select count(*) from public.ops_recovery_attempts where status = 'awaiting_approval'),
      'orders_last_window', (select count(*) from public.orders where created_at > now() - make_interval(hours => v_hours)),
      'ai_usage_today', (select jsonb_object_agg(kind, jsonb_build_object('calls', calls, 'cost_usd', cost_usd)) from public.ops_ai_usage where day = current_date));
  elsif p_tool = 'list_incidents' then
    return jsonb_build_object('incidents', coalesce((select jsonb_agg(jsonb_build_object('ref', ref, 'title', title, 'severity', severity, 'status', status, 'service', service,
                                  'occurrences', occurrences, 'detected', detected_at, 'last_seen', last_seen, 'ai', ai_status, 'recovery', recovery_status) order by detected_at desc)
      from (select * from public.ops_incidents
             where (p_args->>'status' is null or (p_args->>'status' = 'open' and status <> 'resolved') or status = p_args->>'status')
               and (p_args->>'severity' is null or severity = p_args->>'severity')
               and detected_at > now() - make_interval(hours => v_hours)
             order by detected_at desc limit v_lim) z), '[]'::jsonb));
  elsif p_tool = 'get_incident' then
    select * into i from public.ops_incidents where ref = upper(btrim(coalesce(p_args->>'ref', '')));
    if not found then return jsonb_build_object('error', 'No incident with that reference.'); end if;
    return public.ops_incident_evidence(i.id) || jsonb_build_object(
      'latest_report', (select jsonb_build_object('version', version, 'status', status, 'report', report, 'error', error) from public.ops_reports where incident_id = i.id order by version desc limit 1),
      'timeline', coalesce((select jsonb_agg(jsonb_build_object('at', created_at, 'by', actor_kind, 'event', action, 'outcome', outcome) order by created_at)
                            from (select * from public.ops_audit where incident_id = i.id order by created_at desc limit 25) t), '[]'::jsonb),
      'recovery_attempts', coalesce((select jsonb_agg(jsonb_build_object('action', action_id, 'status', status, 'requested_by', requested_by, 'note', authorization_note,
                                     'verification', verification, 'verified', verification_passed, 'failure', failure) order by created_at)
                                     from public.ops_recovery_attempts where incident_id = i.id), '[]'::jsonb));
  elsif p_tool = 'traffic_and_abuse' then
    return jsonb_build_object('window_hours', v_hours,
      'rate_limit_events', coalesce((select jsonb_agg(jsonb_build_object('endpoint', endpoint, 'kind', kind, 'events', c, 'distinct_sources', s)) from
                              (select endpoint, kind, count(*) c, count(distinct key) s from public.security_events where created_at > now() - make_interval(hours => v_hours) group by endpoint, kind) x), '[]'::jsonb),
      'active_blocks', (select count(*) from public.rl_blocks where blocked_until > now()),
      'signups', (select jsonb_build_object('total', count(*), 'unconfirmed', count(*) filter (where email_confirmed_at is null)) from auth.users where created_at > now() - make_interval(hours => v_hours)),
      'signups_per_hour_peak', (select max(c) from (select date_trunc('hour', created_at) h, count(*) c from auth.users where created_at > now() - make_interval(hours => v_hours) group by 1) x),
      'logins', public.ops_login_totals(v_hours),
      'note', 'Only traffic that reaches ClickFood''s own server functions and database functions is counted here. Direct traffic to Supabase and Vercel is not visible on the current plans.');
  elsif p_tool = 'order_health' then
    return jsonb_build_object('window_hours', v_hours,
      'orders_by_status', (select jsonb_object_agg(status, c) from (select status, count(*) c from public.orders where created_at > now() - make_interval(hours => v_hours) group by status) x),
      'cancel_reasons', (select jsonb_object_agg(coalesce(cancel_reason, 'unknown'), c) from (select cancel_reason, count(*) c from public.orders where status = 'cancelled' and created_at > now() - make_interval(hours => v_hours) group by cancel_reason) x),
      'orders_per_hour', (select jsonb_object_agg(to_char(h, 'MM-DD HH24:00'), c) from (select date_trunc('hour', created_at) h, count(*) c from public.orders where created_at > now() - make_interval(hours => least(v_hours, 48)) group by 1 order by 1) x),
      'stuck_now', (select count(*) from public.orders o where o.status in ('received', 'preparing') and o.created_at > now() - interval '2 days'
                     and coalesce(nullif(o.delivery_location->>'collectionTime', '')::timestamptz, o.created_at) < now() - interval '2 hours'));
  elsif p_tool = 'payment_health' then
    return jsonb_build_object('window_hours', v_hours,
      'payment_events', (select jsonb_object_agg(event_type, c) from (select event_type, count(*) c from public.payment_events where created_at > now() - make_interval(hours => v_hours) group by event_type) x),
      'checkouts_by_status', (select jsonb_object_agg(status, c) from (select status, count(*) c from public.checkout_sessions where created_at > now() - make_interval(hours => v_hours) group by status) x),
      'paid_without_order', (select count(*) from public.checkout_sessions where status = 'paid' and group_id is null and coalesce(jsonb_array_length(order_ids), 0) = 0 and updated_at < now() - interval '10 minutes'),
      'duplicate_payments_open', (select count(*) from public.payment_duplicates where coalesce(status, '') <> 'refunded'),
      'note', 'Counts only. PayFast is the source of truth for whether a payment went through.');
  elsif p_tool = 'notification_health' then
    return jsonb_build_object('window_hours', v_hours,
      'jobs', (select jsonb_object_agg(channel || ':' || status, c) from (select channel, status, count(*) c from public.notification_jobs where created_at > now() - make_interval(hours => v_hours) group by channel, status) x),
      'emails', (select jsonb_object_agg(status, c) from (select status, count(*) c from public.email_outbox where created_at > now() - make_interval(hours => v_hours) group by status) x),
      'trigger_errors', (select count(*) from public.notification_errors where created_at > now() - make_interval(hours => v_hours)));
  elsif p_tool = 'scheduled_jobs' then
    return jsonb_build_object('jobs', (select jsonb_agg(jsonb_build_object('name', j.jobname, 'schedule', j.schedule,
              'runs', (select count(*) from cron.job_run_details d where d.jobid = j.jobid and d.start_time > now() - make_interval(hours => least(v_hours, 48))),
              'failed', (select count(*) from cron.job_run_details d where d.jobid = j.jobid and d.status = 'failed' and d.start_time > now() - make_interval(hours => least(v_hours, 48))))) from cron.job j));
  elsif p_tool = 'run_diagnostics' then
    return jsonb_build_object('findings', public.ops_run_checks(), 'checked_at', now());
  elsif p_tool = 'propose_action' then
    select * into i from public.ops_incidents where ref = upper(btrim(coalesce(p_args->>'ref', '')));
    if not found then return jsonb_build_object('error', 'No incident with that reference.'); end if;
    -- the assistant can only propose: this always waits for a developer
    v_id := public.ops_request_recovery(i.id, p_args->>'action_id', 'assistant', p_args->>'reason', p_developer);
    return jsonb_build_object('attempt_id', v_id, 'status', (select status from public.ops_recovery_attempts where id = v_id),
                              'note', 'Proposed. A developer must approve it in the dashboard; high-risk actions are carried out by a person.');
  elsif p_tool = 'login_health' then
    -- aggregated counts only (no hashes, no addresses); read-only, cannot change any limit
    if to_regprocedure('public.login_report_internal(integer)') is null then return jsonb_build_object('error', 'Login protection is not installed.'); end if;
    return public.login_report_internal(v_hours) - 'settings' || jsonb_build_object('limits', (select to_jsonb(s2) - 'id' - 'updated_by' from public.login_limit_settings s2 where id = 1));
  elsif p_tool = 'add_note' then
    select * into i from public.ops_incidents where ref = upper(btrim(coalesce(p_args->>'ref', '')));
    if not found then return jsonb_build_object('error', 'No incident with that reference.'); end if;
    perform public.ops_audit_add(i.id, 'assistant', p_developer, 'note', null, jsonb_build_object('note', left(public.ops_redact(p_args->>'note'), 1000)));
    return jsonb_build_object('ok', true);
  end if;
  return jsonb_build_object('error', 'Unknown tool.');
end $$;

-- Assistant gate: who may chat, and today's budget (checked before every Claude call).
create or replace function public.ops_assistant_gate(p_developer uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.ops_settings; v_used int; r jsonb;
begin
  if not public.ops_has_perm(p_developer, 'chat') then return jsonb_build_object('ok', false, 'error', 'Not allowed.'); end if;
  select * into s from public.ops_settings where id = 1;
  if not s.ai_enabled then return jsonb_build_object('ok', false, 'error', 'AI is switched off in the settings.'); end if;
  r := public.rl_hit('acct:' || p_developer, 'assistant', 20, 300);
  if not coalesce((r->>'allowed')::boolean, true) then return jsonb_build_object('ok', false, 'error', 'Too many messages. Try again shortly.', 'retry_after', r->'retry_after'); end if;
  select coalesce(calls, 0) into v_used from public.ops_ai_usage where day = current_date and kind = 'assistant';
  if coalesce(v_used, 0) >= s.assistant_daily_limit then return jsonb_build_object('ok', false, 'error', 'Today''s assistant limit is reached. It resets at midnight, or raise it in settings.'); end if;
  return jsonb_build_object('ok', true, 'model', s.assistant_model, 'price_in', s.ai_price_in_per_mtok, 'price_out', s.ai_price_out_per_mtok);
end $$;

create or replace function public.ops_record_usage(p_kind text, p_in int, p_out int, p_audio_seconds int default 0, p_cost numeric default null)
returns void language plpgsql security definer set search_path = public as $$
declare s public.ops_settings;
begin
  select * into s from public.ops_settings where id = 1;
  insert into public.ops_ai_usage (day, kind, calls, input_tokens, output_tokens, audio_seconds, cost_usd)
  values (current_date, p_kind, 1, coalesce(p_in, 0), coalesce(p_out, 0), coalesce(p_audio_seconds, 0),
          coalesce(p_cost, round((coalesce(p_in, 0) * s.ai_price_in_per_mtok + coalesce(p_out, 0) * s.ai_price_out_per_mtok) / 1000000.0, 6)))
  on conflict (day, kind) do update set calls = public.ops_ai_usage.calls + 1, input_tokens = public.ops_ai_usage.input_tokens + excluded.input_tokens,
    output_tokens = public.ops_ai_usage.output_tokens + excluded.output_tokens, audio_seconds = public.ops_ai_usage.audio_seconds + excluded.audio_seconds,
    cost_usd = public.ops_ai_usage.cost_usd + excluded.cost_usd;
end $$;

-- ---------- 12. tick (every 2 minutes) + retention (daily) ----------
create or replace function public.ops_tick()
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.ops_run_checks();
  perform public.ops_verify_attempts();
  if exists (select 1 from public.ops_incidents where ai_status = 'queued') then perform public.ops_kick_investigator(); end if;
  -- investigations stuck in "running" (the function died): back to failed, visibly
  update public.ops_incidents set ai_status = 'failed', updated_at = now()
   where ai_status = 'running' and investigation_started_at < now() - interval '10 minutes';
end $$;

create or replace function public.ops_retention()
returns void language plpgsql security definer set search_path = public as $$
declare d int := (select retention_days from public.ops_settings where id = 1);
begin
  delete from public.ops_events where created_at < now() - make_interval(days => d);
  delete from public.ops_check_runs where ran_at < now() - interval '14 days';
  delete from public.rl_counters where window_start < now() - interval '1 day';
  delete from public.rl_blocks where blocked_until < now() - interval '7 days';
  delete from public.security_events where created_at < now() - make_interval(days => d);
  delete from public.ai_messages where created_at < now() - make_interval(days => d);
  delete from public.ai_conversations c where c.updated_at < now() - make_interval(days => d) and not exists (select 1 from public.ai_messages m where m.conversation_id = c.id);
  delete from public.ops_incidents where status = 'resolved' and resolved_at < now() - make_interval(days => d);
end $$;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname in ('ops-tick', 'ops-retention');
    perform cron.schedule('ops-tick', '*/2 * * * *', 'select public.ops_tick()');
    perform cron.schedule('ops-retention', '43 2 * * *', 'select public.ops_retention()');
  end if;
end $$;

-- ---------- 13. access: developers read, nobody writes directly ----------
do $$ declare t text; begin
  foreach t in array array['ops_settings', 'ops_permissions', 'ops_incidents', 'ops_events', 'ops_reports', 'ops_actions', 'ops_recovery_attempts',
                           'ops_audit', 'ops_ai_usage', 'ops_check_runs', 'ops_function_config', 'rl_counters', 'rl_blocks', 'security_events',
                           'ai_conversations', 'ai_messages'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
do $$ declare t text; begin
  foreach t in array array['ops_settings', 'ops_incidents', 'ops_events', 'ops_reports', 'ops_actions', 'ops_recovery_attempts', 'ops_audit', 'ops_ai_usage', 'ops_check_runs', 'security_events'] loop
    execute format('drop policy if exists "ops developer read" on public.%I', t);
    execute format('create policy "ops developer read" on public.%I for select using (public.ops_can(''view''))', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
drop policy if exists "ops permissions developer read" on public.ops_permissions;
create policy "ops permissions developer read" on public.ops_permissions for select using (public.ops_can('view'));
grant select on public.ops_permissions to authenticated;
-- a developer sees only their OWN assistant conversations
drop policy if exists "ai conversations own" on public.ai_conversations;
create policy "ai conversations own" on public.ai_conversations for select using (developer_id = auth.uid() and public.ops_can('chat'));
drop policy if exists "ai conversations own delete" on public.ai_conversations;
create policy "ai conversations own delete" on public.ai_conversations for delete using (developer_id = auth.uid() and public.ops_can('chat'));
grant select, delete on public.ai_conversations to authenticated;
drop policy if exists "ai messages own" on public.ai_messages;
create policy "ai messages own" on public.ai_messages for select using (exists (select 1 from public.ai_conversations c where c.id = conversation_id and c.developer_id = auth.uid()) and public.ops_can('chat'));
grant select on public.ai_messages to authenticated;

revoke all on function public.ops_signal(text, text, text, text, text, text, jsonb, text, int) from public, anon, authenticated;
revoke all on function public.ops_alert(uuid, text) from public, anon, authenticated;
revoke all on function public.ops_run_checks() from public, anon, authenticated;
revoke all on function public.ops_execute_attempt(uuid) from public, anon, authenticated;
revoke all on function public.ops_request_recovery(uuid, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.ops_verify_attempts() from public, anon, authenticated;
revoke all on function public.ops_kick_investigator() from public, anon, authenticated;
revoke all on function public.ops_claim_investigations(int) from public, anon, authenticated;
revoke all on function public.ops_incident_evidence(uuid) from public, anon, authenticated;
revoke all on function public.ops_save_report(uuid, boolean, jsonb, text, int, int, text) from public, anon, authenticated;
revoke all on function public.ops_tool(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.ops_assistant_gate(uuid) from public, anon, authenticated;
revoke all on function public.ops_record_usage(text, int, int, int, numeric) from public, anon, authenticated;
revoke all on function public.ops_tick() from public, anon, authenticated;
revoke all on function public.ops_retention() from public, anon, authenticated;
revoke all on function public.ops_audit_add(uuid, text, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.rl_hit(text, text, int, int) from public, anon, authenticated;
revoke all on function public.ops_has_perm(uuid, text) from public, anon, authenticated;
grant execute on function public.ops_claim_investigations(int), public.ops_incident_evidence(uuid), public.ops_save_report(uuid, boolean, jsonb, text, int, int, text),
  public.ops_tool(uuid, text, jsonb), public.ops_assistant_gate(uuid), public.ops_record_usage(text, int, int, int, numeric), public.rl_hit(text, text, int, int),
  public.ops_has_perm(uuid, text), public.ops_audit_add(uuid, text, uuid, text, text, jsonb) to service_role;
grant execute on function public.ops_report_client_error(text, text, text, text, text, jsonb, text) to anon, authenticated;
grant execute on function public.ops_dev(text, uuid, jsonb) to authenticated;
grant execute on function public.ops_can(text) to authenticated;

-- live dashboard updates
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'ops_incidents') then
    alter publication supabase_realtime add table public.ops_incidents;
  end if;
exception when undefined_object then null; end $$;

-- logged-out visitors only need to REPORT errors; every other helper is
-- closed to them (Supabase grants new functions to anon by default)
revoke all on function public.ops_dev(text, uuid, jsonb), public.ops_can(text), public.ops_redact(text), public.ops_sev_rank(text) from public, anon;
revoke all on function public.ops_client_key() from public, anon, authenticated;
grant execute on function public.ops_dev(text, uuid, jsonb), public.ops_can(text) to authenticated;
