-- ============================================================
-- ClickFood: "why are you deleting your account?" (2026-10-12)
-- Runs after account_deletion.sql and approval_emails.sql.
--
-- delete_my_account(p_reason, p_details) now requires one of the reasons
-- below. It runs the existing deletion (renamed delete_my_account_core);
-- only if that succeeds is the reason saved (with no link to the person)
-- and every developer told, in the app and by email.
-- Safe to run more than once.
-- ============================================================

do $$ begin
  if exists (select 1 from pg_proc where proname = 'delete_my_account' and pronargs = 0 and pronamespace = 'public'::regnamespace)
     and not exists (select 1 from pg_proc where proname = 'delete_my_account_core' and pronamespace = 'public'::regnamespace) then
    alter function public.delete_my_account() rename to delete_my_account_core;
  end if;
end $$;
drop function if exists public.delete_my_account();
revoke all on function public.delete_my_account_core() from public, anon, authenticated;

create or replace function public.account_deletion_reasons()
returns text[] language sql immutable as $$
  select array[
    'not_using', 'graduated', 'another_account', 'few_shops', 'prices', 'order_problems',
    'payment_problems', 'app_problems', 'privacy', 'too_many_messages', 'stopped_selling', 'other']::text[]
$$;

create or replace function public.account_deletion_reason_label(p text)
returns text language sql immutable as $$
  select case p
    when 'not_using' then 'I don''t use ClickFood any more'
    when 'graduated' then 'I graduated or left UP'
    when 'another_account' then 'I made another account'
    when 'few_shops' then 'Not enough food or shops near me'
    when 'prices' then 'The food is too expensive'
    when 'order_problems' then 'Problems with orders or collection'
    when 'payment_problems' then 'Payment problems'
    when 'app_problems' then 'The app is hard to use or has bugs'
    when 'privacy' then 'Privacy concerns'
    when 'too_many_messages' then 'Too many notifications or emails'
    when 'stopped_selling' then 'I stopped selling food'
    when 'other' then 'Other'
    else p end
$$;

-- Reasons only: no user id, name or email is kept here.
create table if not exists public.account_deletions (
  id uuid primary key default gen_random_uuid(),
  reason text not null check (reason = any (public.account_deletion_reasons())),
  details text check (details is null or length(details) <= 500),
  had_shop boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.account_deletions enable row level security;
drop policy if exists "account deletions developer read" on public.account_deletions;
create policy "account deletions developer read" on public.account_deletions for select
  using (public."current_role"() = 'developer');
revoke all on public.account_deletions from anon;
revoke insert, update, delete on public.account_deletions from authenticated;
grant select on public.account_deletions to authenticated;

create or replace function public.delete_my_account(p_reason text, p_details text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_details text := nullif(btrim(left(coalesce(p_details, ''), 500)), '');
  v_first text;
  v_shop text;
  v_msg text;
  d record;
begin
  if v_uid is null then raise exception 'Please sign in first.'; end if;
  if v_reason is null or not (v_reason = any (public.account_deletion_reasons())) then
    raise exception 'Please tell us why you are deleting your account.';
  end if;
  if v_reason = 'other' and v_details is null then
    raise exception 'Please tell us a little more.';
  end if;
  -- captured before the account is wiped
  v_first := public.first_name_of(v_uid);
  select name into v_shop from public.stores
   where id = public.my_student_shop_id(v_uid);

  perform public.delete_my_account_core();   -- refuses while orders are in progress

  insert into public.account_deletions (reason, details, had_shop) values (v_reason, v_details, v_shop is not null);
  v_msg := v_first || ' deleted their account. Reason: ' || public.account_deletion_reason_label(v_reason)
           || coalesce(' (' || v_details || ')', '') || '.'
           || case when v_shop is not null then ' Their shop ' || v_shop || ' was closed.' else '' end;
  for d in select id, email, name from public.profiles where role = 'developer' and coalesce(active, true) loop
    insert into public.notifications (user_id, message, type) values (d.id, v_msg, 'account_deleted');
    perform public.queue_email('account_deleted_notice', 'account', v_uid, d.id, d.email, d.name,
      jsonb_build_object('student_first_name', v_first, 'reason', public.account_deletion_reason_label(v_reason),
                         'details', v_details, 'shop_name', v_shop));
  end loop;
end $$;
revoke all on function public.delete_my_account(text, text) from public, anon;
grant execute on function public.delete_my_account(text, text) to authenticated;
