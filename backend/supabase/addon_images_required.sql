-- =========================================================================
-- Add-ons must have a picture (2026-10-02)
-- Customers see a small picture of every add-on at checkout, so a shop can't
-- save an add-on without one. The manager app asks for it too; this is the
-- rule the database itself enforces. Every add-on already had a picture when
-- this was added. Safe to run more than once.
-- =========================================================================
alter table public.menu_addons drop constraint if exists menu_addons_image_required;
alter table public.menu_addons add constraint menu_addons_image_required
  check (image_url is not null and btrim(image_url) <> '');
