-- Undo supabase/approval_emails.sql (sent-email history is kept).
begin;
drop trigger if exists trg_email_on_store_approval on public.stores;
drop trigger if exists trg_email_on_driver_approval on public.profiles;
drop function if exists public.email_on_store_approval();
drop function if exists public.email_on_driver_approval();
drop function if exists public.resend_email(uuid);
drop function if exists public.retry_stuck_emails();
drop function if exists public.queue_email(text, text, uuid, uuid, text, text, jsonb);
drop function if exists public.dispatch_email(uuid);
do $$ begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule('retry-stuck-emails') where exists (select 1 from cron.job where jobname = 'retry-stuck-emails');
  end if;
end $$;
commit;
