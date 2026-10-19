-- Undo student_extras.sql
drop trigger if exists trg_enforce_student_extra on public.item_extras;
drop function if exists public.enforce_student_extra();
drop policy if exists "item_extras student seller write" on public.item_extras;
drop policy if exists "item_extra_links student seller write" on public.item_extra_links;
