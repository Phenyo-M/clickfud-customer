-- =========================================================================
-- ClickFood — Phase 5a: staff permissions + two-step login checks (2026-10-01)
--
-- Run this BEFORE manager_reports.sql and inventory_ingredients.sql: their
-- money and stock functions call assert_store_perm() / has_store_perm().
--
-- Permissions (per staff login, per shop):
--   view_reports     — Reports tab (sales, products, customers)
--   process_refunds  — Refunds tab (approve / reject / pay back)
--   manage_inventory — Ingredients, recipes, stock counts, costs
-- The shop's manager always has all of them. Products, prices, staff and
-- shop settings stay manager-only. A manager can grant any of the three to
-- the shop's (shared) kitchen login.
--
-- Two-step login (Supabase Auth MFA, authenticator app):
--   * anyone who has set it up must have entered their code in this session
--     (JWT aal = aal2) before money/stock actions run;
--   * platform_config.require_manager_mfa = true makes it compulsory for
--     managers (they're asked to set it up first).
-- Safe to run more than once.
-- =========================================================================

create table if not exists public.staff_permissions (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  store_id uuid not null references public.stores (id) on delete cascade,
  permissions text[] not null default '{}',
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint staff_permissions_known check (permissions <@ array['view_reports', 'process_refunds', 'manage_inventory']::text[])
);
alter table public.staff_permissions enable row level security;
drop policy if exists "perms: own or manager reads" on public.staff_permissions;
create policy "perms: own or manager reads" on public.staff_permissions for select
  using (user_id = auth.uid() or (public.current_role() = 'manager' and store_id = public.current_store_id()));

alter table public.platform_config add column if not exists require_manager_mfa boolean not null default false;

-- Does this user (any user id; used by Edge Functions too) hold this permission for this shop?
create or replace function public.user_has_store_perm(p_user uuid, p_store uuid, p_perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = p_user and coalesce(p.active, true) and p.store_id = p_store
      and (p.role = 'manager'
           or (p.role = 'kitchen' and exists (select 1 from public.staff_permissions sp
                                              where sp.user_id = p.id and sp.store_id = p_store and p_perm = any (sp.permissions))))
  )
$$;
create or replace function public.has_store_perm(p_store uuid, p_perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and public.user_has_store_perm(auth.uid(), p_store, p_perm)
$$;

-- Two-step login state for the current session.
create or replace function public.my_mfa_enrolled()
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
$$;
create or replace function public.assert_mfa_ok()
returns void language plpgsql stable security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then return; end if;
  if public.my_mfa_enrolled() then
    if coalesce(auth.jwt()->>'aal', 'aal1') <> 'aal2' then
      raise exception 'Please enter the code from your authenticator app first (sign out and in again if you weren''t asked).';
    end if;
  elsif public.current_role() = 'manager' and coalesce((select require_manager_mfa from public.platform_config limit 1), false) then
    raise exception 'Two-step login is required for managers. Set it up in your Profile first.';
  end if;
end $$;

-- Use at the top of every money / stock function.
create or replace function public.assert_store_perm(p_store uuid, p_perm text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if p_store is null or not public.has_store_perm(p_store, p_perm) then
    raise exception '%', case p_perm
      when 'view_reports' then 'You don''t have access to sales reports.'
      when 'process_refunds' then 'You don''t have access to refunds.'
      when 'manage_inventory' then 'You don''t have access to ingredients and stock.'
      else 'You don''t have access to this.' end;
  end if;
  perform public.assert_mfa_ok();
end $$;

-- Manager sets what the shop's kitchen login may do. Logged.
create or replace function public.set_staff_permissions(p_user uuid, p_permissions text[])
returns public.staff_permissions
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.current_store_id();
  v_old text[];
  v public.staff_permissions;
begin
  if public.current_role() is distinct from 'manager' or v_store is null then
    raise exception 'Only the shop manager can change permissions.';
  end if;
  perform public.assert_mfa_ok();
  if not exists (select 1 from public.profiles where id = p_user and role = 'kitchen' and store_id = v_store) then
    raise exception 'That is not one of your kitchen logins.';
  end if;
  select permissions into v_old from public.staff_permissions where user_id = p_user;
  insert into public.staff_permissions (user_id, store_id, permissions, updated_by, updated_at)
  values (p_user, v_store, coalesce(p_permissions, '{}'), auth.uid(), now())
  on conflict (user_id) do update set permissions = excluded.permissions, store_id = excluded.store_id, updated_by = excluded.updated_by, updated_at = now()
  returning * into v;
  insert into public.audit_log (actor_id, actor_name, action, target_type, target_id, target_name, reason)
  values (auth.uid(), (select coalesce(name, email) from public.profiles where id = auth.uid()), 'permissions_changed', 'staff', p_user,
          (select email from public.profiles where id = p_user),
          coalesce(array_to_string(v_old, ', '), 'none') || ' -> ' || coalesce(nullif(array_to_string(v.permissions, ', '), ''), 'none'));
  return v;
end $$;

-- What can I do here? (drives which tabs the Staff app shows)
create or replace function public.my_store_permissions()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'view_reports', public.has_store_perm(public.current_store_id(), 'view_reports'),
    'process_refunds', public.has_store_perm(public.current_store_id(), 'process_refunds'),
    'manage_inventory', public.has_store_perm(public.current_store_id(), 'manage_inventory'),
    'mfa_enrolled', public.my_mfa_enrolled(),
    'mfa_required', public.current_role() = 'manager' and coalesce((select require_manager_mfa from public.platform_config limit 1), false))
$$;

revoke all on function public.user_has_store_perm(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.user_has_store_perm(uuid, uuid, text) to service_role;
revoke all on function public.set_staff_permissions(uuid, text[]) from public, anon;
grant execute on function public.set_staff_permissions(uuid, text[]) to authenticated;
grant execute on function public.assert_store_perm(uuid, text) to authenticated, service_role;
grant execute on function public.my_store_permissions() to authenticated;
