-- ============================================================
-- CLICKFOOD, show / hide business (partner) shops in the customer app
--
-- One switch, set by a developer in the developer app (Shops page).
-- Off = students only see student seller shops (the launch setting).
-- Read by everyone, guests included, through public_app_flags() (the
-- platform_config table itself stays closed to logged-out visitors).
-- Only a developer can change it; every change is audited.
-- Safe to run more than once.
-- ============================================================

alter table public.platform_config add column if not exists show_partner_shops boolean not null default false;

create or replace function public.public_app_flags()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('show_partner_shops', coalesce((select show_partner_shops from public.platform_config where id = 1), false))
$$;
revoke all on function public.public_app_flags() from public;
grant execute on function public.public_app_flags() to anon, authenticated;

create or replace function public.set_show_partner_shops(p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_old boolean;
begin
  if v_uid is null or not exists (select 1 from public.profiles where id = v_uid and role = 'developer' and coalesce(active, true)) then
    return jsonb_build_object('ok', false, 'error', 'Not allowed.');
  end if;
  if p_on is null then return jsonb_build_object('ok', false, 'error', 'Bad request.'); end if;
  select show_partner_shops into v_old from public.platform_config where id = 1 for update;
  update public.platform_config set show_partner_shops = p_on, updated_at = now() where id = 1;
  begin
    perform public.ops_audit_add(null, 'developer', v_uid, 'show_partner_shops', case when p_on then 'shown' else 'hidden' end,
      jsonb_build_object('before', v_old, 'after', p_on));
  exception when others then null;   -- auditing never blocks the switch
  end;
  return jsonb_build_object('ok', true, 'show_partner_shops', p_on);
end $$;
revoke all on function public.set_show_partner_shops(boolean) from public, anon;
grant execute on function public.set_show_partner_shops(boolean) to authenticated;
