-- Undo supabase/account_deletion.sql. Already-deleted accounts stay
-- anonymised (their login and personal data are gone for good).
begin;
drop function if exists public.delete_my_account();
drop function if exists public.delete_student_shop();
drop function if exists public.close_student_shop_internal(uuid, uuid);
drop function if exists public.my_student_shop_id(uuid);
-- prevent_role_change without the cleanup escape hatch
create or replace function public.prevent_role_change()
returns trigger language plpgsql as $function$
declare v_actor uuid := auth.uid(); v_actor_role text;
begin
  if new.role is distinct from old.role then new.role := old.role; end if;
  if old.store_id is not null and new.store_id is distinct from old.store_id then new.store_id := old.store_id; end if;
  if v_actor is null then return new; end if;
  v_actor_role := public.current_role();
  if v_actor_role = 'developer' then return new; end if;
  if old.store_id is null and new.store_id is not null
     and not exists (select 1 from public.stores s where s.id = new.store_id and s.manager_id = new.id) then
    new.store_id := null;
  end if;
  if v_actor = old.id then
    new.active := old.active; new.status := old.status; new.rejection_reason := old.rejection_reason; new.email := old.email;
  else
    if v_actor_role is distinct from 'manager' then new.active := old.active; end if;
    new.status := old.status; new.rejection_reason := old.rejection_reason; new.email := old.email;
  end if;
  return new;
end;
$function$;
commit;
