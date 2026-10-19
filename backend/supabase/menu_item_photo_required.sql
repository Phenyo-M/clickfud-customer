-- =========================================================================
-- Menu items must have a photo (2026-10-02)
--   * a new menu item can't be saved without a photo
--   * editing an item (name, price, description, category, photo) needs one
--   * an item without a photo can't be approved for customers
-- Rejecting, suspending and stock changes still work, so items saved before
-- this rule (without a photo) can still be handled. The manager app asks for
-- the photo too; this is the rule the database itself enforces.
-- Safe to run more than once.
-- =========================================================================
create or replace function public.require_menu_item_photo()
returns trigger language plpgsql as $$
begin
  if coalesce(btrim(new.image), '') <> '' then return new; end if;
  if tg_op = 'INSERT' then
    raise exception 'Please add a photo of this menu item.' using errcode = 'P0001';
  end if;
  if new.status = 'approved' and old.status is distinct from 'approved' then
    raise exception 'This item has no photo, so it can''t be approved. Ask the shop to add one.' using errcode = 'P0001';
  end if;
  if (new.name, new.price, new.description, new.category, new.image)
     is distinct from (old.name, old.price, old.description, old.category, old.image) then
    raise exception 'Please add a photo of this menu item.' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists trg_require_menu_item_photo on public.menu_items;
create trigger trg_require_menu_item_photo before insert or update on public.menu_items
  for each row execute function public.require_menu_item_photo();
