-- =========================================================================
-- CLICKFOOD — indexes for links between tables that the apps filter or
-- join on (audit 2026-10-02 finding 12). Indexes only: no data changes.
-- Links that are only "who did this" stamps (created_by, approved_by, ...)
-- are left without an index on purpose: nothing looks them up.
-- Undo: drop the indexes named below (drop index if exists ...).
-- =========================================================================
create index if not exists stores_manager_id_idx on public.stores (manager_id);
create index if not exists reviews_customer_id_idx on public.reviews (customer_id);
create index if not exists refund_requests_customer_id_idx on public.refund_requests (customer_id);
create index if not exists payment_events_customer_id_idx on public.payment_events (customer_id);
create index if not exists checkout_sessions_group_id_idx on public.checkout_sessions (group_id);
create index if not exists orders_collected_by_idx on public.orders (collected_by);
create index if not exists group_orders_store_id_idx on public.group_orders (store_id);
create index if not exists group_orders_leader_id_idx on public.group_orders (leader_id);
create index if not exists group_order_items_user_id_idx on public.group_order_items (user_id);
create index if not exists group_order_items_menu_item_id_idx on public.group_order_items (menu_item_id);
create index if not exists group_share_extra_payments_group_id_idx on public.group_share_extra_payments (group_id);
create index if not exists inventory_movements_menu_item_id_idx on public.inventory_movements (menu_item_id);
create index if not exists images_shop_id_idx on public.images (shop_id);
create index if not exists image_quality_checks_store_id_idx on public.image_quality_checks (store_id);
create index if not exists menu_item_reviews_store_id_idx on public.menu_item_reviews (store_id);
create index if not exists staff_permissions_store_id_idx on public.staff_permissions (store_id);
create index if not exists polls_store_id_idx on public.polls (store_id);
create index if not exists poll_votes_user_id_idx on public.poll_votes (user_id);
create index if not exists food_lists_owner_id_idx on public.food_lists (owner_id);
create index if not exists food_list_items_menu_item_id_idx on public.food_list_items (menu_item_id);
create index if not exists ingredient_batches_ingredient_id_idx on public.ingredient_batches (ingredient_id);
create index if not exists ingredient_movements_store_id_idx on public.ingredient_movements (store_id);
create index if not exists recipe_items_ingredient_id_idx on public.recipe_items (ingredient_id);
create index if not exists waste_records_ingredient_id_idx on public.waste_records (ingredient_id);
