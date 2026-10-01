-- ============================================================
-- NEW (2026-09-28) — Order idempotency key (duplicate-order protection)
--
-- A cash (COD) order is a direct INSERT from the customer's browser.
-- If the connection drops AFTER Postgres commits the row but BEFORE the
-- response reaches the phone, the app sees a network error, leaves the
-- items in the cart, and a retry used to create a second, real order.
--
-- The customer app now sends a client_request_id (a UUID generated once
-- per checkout attempt per shop, and reused on every retry of that same
-- attempt). This unique index makes the database itself reject the
-- duplicate; the app catches that rejection (23505) and simply loads the
-- order that already exists instead of creating another one.
--
-- Partial index (only where set) so every historical order and every
-- server-created order (finalize_paystack_checkout, which has its own
-- reference-based idempotency) is unaffected.
--
-- Safe to run more than once. The customer app keeps working before
-- this is run (it falls back to inserting without the column), it just
-- isn't protected against duplicates until it is.
-- ============================================================
alter table public.orders add column if not exists client_request_id uuid;

create unique index if not exists orders_customer_client_request_uidx
  on public.orders (customer_id, client_request_id)
  where client_request_id is not null;
