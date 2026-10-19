-- Rollback for login_protection.sql. Run ONLY after redeploying the previous
-- secure-login (copy kept in archive/secure-login-live-2026-10-16/index.ts),
-- otherwise logins fail because login_guard no longer exists.
-- Removes counters and per-minute metrics only; no student or order data.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'login-cleanup';
  end if;
end $$;
drop function if exists public.login_guard(text, text, text);
drop function if exists public.login_record(text, text, text, text, int, jsonb);
drop function if exists public.login_fail_row(text, int, int);
drop function if exists public.login_report(int);
drop function if exists public.login_report_internal(int);
drop function if exists public.login_pctl(jsonb, bigint, numeric);
drop function if exists public.login_limits_update(jsonb);
drop function if exists public.login_cleanup();
drop function if exists public.login_signal(text, text, text, text, jsonb);
drop function if exists public.login_row(text);
drop function if exists public.login_wait(int);
drop function if exists public.login_metric_add(text, bigint);
drop table if exists public.login_metrics;
drop table if exists public.login_known_pairs;
drop table if exists public.login_ip_accounts;
drop table if exists public.login_rl_state;
drop table if exists public.login_limit_settings;
