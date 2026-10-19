-- Undo ops_monitoring.sql (removes the monitoring system and its history).
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname in ('ops-tick', 'ops-retention');
  end if;
end $$;
drop trigger if exists trg_a1_limit_order_rate on public.orders;
drop function if exists public.limit_order_rate();
drop function if exists public.ops_tick();
drop function if exists public.ops_retention();
drop function if exists public.ops_record_usage(text, int, int, int, numeric);
drop function if exists public.ops_assistant_gate(uuid);
drop function if exists public.ops_tool(uuid, text, jsonb);
drop function if exists public.ops_dev(text, uuid, jsonb);
drop function if exists public.ops_save_report(uuid, boolean, jsonb, text, int, int, text);
drop function if exists public.ops_incident_evidence(uuid);
drop function if exists public.ops_claim_investigations(int);
drop function if exists public.ops_kick_investigator();
drop function if exists public.ops_verify_attempts();
drop function if exists public.ops_request_recovery(uuid, text, text, text, uuid);
drop function if exists public.ops_execute_attempt(uuid);
drop function if exists public.ops_run_checks();
drop function if exists public.ops_report_client_error(text, text, text, text, text, jsonb, text);
drop function if exists public.ops_alert(uuid, text);
drop function if exists public.ops_signal(text, text, text, text, text, text, jsonb, text, int);
drop function if exists public.ops_audit_add(uuid, text, uuid, text, text, jsonb);
drop function if exists public.rl_hit(text, text, int, int);
drop table if exists public.ai_messages, public.ai_conversations, public.security_events, public.rl_blocks, public.rl_counters,
  public.ops_function_config, public.ops_check_runs, public.ops_ai_usage, public.ops_audit, public.ops_recovery_attempts,
  public.ops_actions, public.ops_reports, public.ops_events, public.ops_incidents, public.ops_permissions, public.ops_settings;
drop sequence if exists public.ops_incident_seq;
drop function if exists public.ops_can(text);
drop function if exists public.ops_has_perm(uuid, text);
drop function if exists public.ops_client_key();
drop function if exists public.ops_redact(text);
drop function if exists public.ops_sev_rank(text);
