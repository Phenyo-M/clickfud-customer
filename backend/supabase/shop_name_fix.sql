-- ============================================================
-- ClickFood: shop names (2026-10-12)
-- Runs after account_deletion.sql and student_application_details.sql.
--
-- Shop names are unique (stores_name_key). A shop closed by its student
-- kept its name forever, so "ClickFood." could never be used again, and
-- the app showed the raw database error. Now:
--   * closing a student shop renames the kept row "<name> (closed abc123)"
--     so the name is free again (also done once for shops already closed);
--   * opening or renaming a shop with a taken name gives a clear message.
-- Safe to run more than once.
-- ============================================================

create or replace function public.closed_shop_name(p_name text, p_id uuid)
returns text language sql immutable as $$
  select left(p_name, 40) || ' (closed ' || substr(replace(p_id::text, '-', ''), 1, 6) || ')'
$$;

create or replace function public.close_student_shop_internal(p_store uuid, p_owner uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_claims text := current_setting('request.jwt.claims', true);
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('clickfood.account_cleanup', 'on', true);
  delete from public.menu_items where store_id = p_store;
  update public.stores
     set status = 'archived', is_published = false, store_closed = true,
         archived_by = p_owner, archived_at = now(), archived_reason = 'Deleted by the student',
         name = case when name like '% (closed ______)' then name else public.closed_shop_name(name, id) end,
         slug = case when slug like '%-closed-%' then slug else slug || '-closed-' || substr(replace(id::text, '-', ''), 1, 6) end
   where id = p_store;
  delete from public.seller_profiles where store_id = p_store;
  update public.profiles set store_id = null where id = p_owner and store_id = p_store;
  perform set_config('clickfood.account_cleanup', 'off', true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
end $$;
revoke all on function public.close_student_shop_internal(uuid, uuid) from public, anon, authenticated;

-- Free the names of student shops already closed by their owners.
update public.stores
   set name = public.closed_shop_name(name, id),
       slug = slug || '-closed-' || substr(replace(id::text, '-', ''), 1, 6)
 where seller_kind = 'student' and status = 'archived' and archived_by = manager_id
   and name not like '% (closed ______)';

-- A clear message instead of "duplicate key value violates unique
-- constraint" whenever a shop name (or its slug) is already taken.
create or replace function public.check_shop_name_free()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.name is distinct from old.name then
    if exists (select 1 from public.stores s where lower(btrim(s.name)) = lower(btrim(new.name)) and s.id <> new.id) then
      raise exception 'That shop name is already taken. Please choose another name.' using errcode = 'P0001';
    end if;
  end if;
  if new.slug is not null and (tg_op = 'INSERT' or new.slug is distinct from old.slug)
     and exists (select 1 from public.stores s where s.slug = new.slug and s.id <> new.id) then
    new.slug := new.slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);
  end if;
  return new;
end $$;
drop trigger if exists trg_check_shop_name_free on public.stores;
create trigger trg_check_shop_name_free before insert or update of name, slug on public.stores
  for each row execute function public.check_shop_name_free();
