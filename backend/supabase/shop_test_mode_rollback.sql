-- Undo shop_test_mode.sql: ordering_block_reason goes back to the
-- student_collection_times.sql version (re-run that file), then:
drop trigger if exists trg_protect_store_test_mode on public.stores;
drop function if exists public.protect_store_test_mode();
alter table public.stores drop column if exists test_mode;
