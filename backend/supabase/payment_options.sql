-- ============================================================
-- CLICKFOOD, switch online payment (PayFast) on or off, and show / hide
-- RecessBox in the customer app (hidden by default while it is being built)
--
-- Set by a developer in the developer app (Payments page). Off = students
-- only see "Cash on Collection" at checkout and group orders (online only)
-- are hidden. Enforced on the server too: create-payfast-payment refuses
-- new payments while it is off, so an old or edited app can't get round it.
-- Payments already made, refunds and PayFast notifications keep working.
-- Read by everyone through public_app_flags(); only a developer can change
-- it, every change is audited. Needs show_partner_shops.sql first.
-- Safe to run more than once.
-- ============================================================

alter table public.platform_config add column if not exists online_payments_enabled boolean not null default true;
alter table public.platform_config add column if not exists show_recessbox boolean not null default false;

create or replace function public.public_app_flags()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'show_partner_shops', coalesce((select show_partner_shops from public.platform_config where id = 1), false),
    'online_payments', coalesce((select online_payments_enabled from public.platform_config where id = 1), true),
    'show_recessbox', coalesce((select show_recessbox from public.platform_config where id = 1), false))
$$;
revoke all on function public.public_app_flags() from public;
grant execute on function public.public_app_flags() to anon, authenticated;

create or replace function public.set_online_payments(p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_old boolean;
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid and role = 'developer' and coalesce(active, true)) then
    return jsonb_build_object('ok', false, 'error', 'Not allowed.');
  end if;
  if p_on is null then return jsonb_build_object('ok', false, 'error', 'Bad request.'); end if;
  select online_payments_enabled into v_old from public.platform_config where id = 1 for update;
  update public.platform_config set online_payments_enabled = p_on, updated_at = now() where id = 1;
  begin
    perform public.ops_audit_add(null, 'developer', v_uid, 'online_payments', case when p_on then 'on' else 'off' end,
      jsonb_build_object('before', v_old, 'after', p_on));
  exception when others then null;
  end;
  return jsonb_build_object('ok', true, 'online_payments', p_on);
end $$;
revoke all on function public.set_online_payments(boolean) from public, anon;
grant execute on function public.set_online_payments(boolean) to authenticated;

create or replace function public.set_show_recessbox(p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_old boolean;
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid and role = 'developer' and coalesce(active, true)) then
    return jsonb_build_object('ok', false, 'error', 'Not allowed.');
  end if;
  if p_on is null then return jsonb_build_object('ok', false, 'error', 'Bad request.'); end if;
  select show_recessbox into v_old from public.platform_config where id = 1 for update;
  update public.platform_config set show_recessbox = p_on, updated_at = now() where id = 1;
  begin
    perform public.ops_audit_add(null, 'developer', v_uid, 'show_recessbox', case when p_on then 'shown' else 'hidden' end,
      jsonb_build_object('before', v_old, 'after', p_on));
  exception when others then null;
  end;
  return jsonb_build_object('ok', true, 'show_recessbox', p_on);
end $$;
revoke all on function public.set_show_recessbox(boolean) from public, anon;
grant execute on function public.set_show_recessbox(boolean) to authenticated;
