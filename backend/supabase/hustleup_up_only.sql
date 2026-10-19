-- ============================================================
-- CLICKFOOD, hustleUP is a University of Pretoria programme (2026-10-18)
-- Student sellers whose shop is not at UP are never saved as hustleUP
-- members, whatever the request says. The apps only ask UP students.
-- Safe to run more than once. Rollback: drop the trigger below.
-- ============================================================
create or replace function public.hustleup_up_only()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.hustleup_member and not exists (
       select 1 from public.stores s where s.id = new.store_id and s.university = 'University of Pretoria') then
    new.hustleup_member := false;
  end if;
  return new;
end $$;
revoke all on function public.hustleup_up_only() from public, anon, authenticated;
drop trigger if exists trg_hustleup_up_only on public.seller_profiles;
create trigger trg_hustleup_up_only before insert or update of hustleup_member on public.seller_profiles
  for each row execute function public.hustleup_up_only();

-- existing non-UP sellers: not members
update public.seller_profiles sp set hustleup_member = false
  from public.stores s where s.id = sp.store_id and sp.hustleup_member and s.university is distinct from 'University of Pretoria';
