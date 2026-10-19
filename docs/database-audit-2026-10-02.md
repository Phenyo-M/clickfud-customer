# ClickFood database audit, 2 October 2026

Scope: live Supabase project ctxnwjjpqxecidzblyok (production), project SQL files, the three apps' code and the Edge Functions.
Method: read-only. Every "confirmed" finding was proven on the live database inside a transaction that was ROLLED BACK, using an existing customer account. Nothing was changed and no private values were printed (only counts).
Reference: C:\Users\mokoe\Videos\ClickFood-database-structure.pdf and ClickFood-database-diagram.pdf (generated from the live database the same day).

## Current state (measured)

| Item | Value |
|---|---|
| Tables | 57, all with row-level security ON (6 server-only with no policies) |
| Links (foreign keys) | 104 |
| Functions | 132 (81 privileged "security definer", all with a fixed search_path) |
| Policies | 114 |
| Database size | 24 MB (largest table: orders, 240 kB) |
| Connections | 27 in use of 60 |
| Scheduled jobs | 2 (timetable-reminder-check, expire-collection-windows), 0 failures in 7 days |
| Data checks | 0 negative stock, 0 orders without a shop, 0 paid card orders without a payment reference |

## Confirmed issues

| # | Severity | Issue | Proof (rolled back) |
|---|---|---|---|
| 1 | CRITICAL | A signed-in customer can create an order already marked PAID by card and READY, without paying. The price is corrected by the database, but payment_method, payment_status and status come from the app. The kitchen would hand over unpaid food. | Inserted as customer: saved card / paid / ready, total R120. |
| 2 | HIGH | Any signed-in user can read every user's email, phone and student number (profiles "select all authenticated"). POPIA risk. | Customer read 8 emails, 4 phones, 2 student numbers of other users. |
| 3 | HIGH | A customer can attach themselves to a shop (profiles.store_id). The guard only blocks changing an existing shop. Rules that only check current_store_id() then apply (unapproved menu items, the shop's image folder in storage, image metadata, menu review log). | current_store_id() became Kota Hub; 3 unapproved menu items became visible. |
| 4 | HIGH | A user can change their own active and status (approval) fields. A deactivated account can switch itself back on. | Update of own active/status succeeded. |
| 5 | MEDIUM | Any signed-in user can create a notification for any other user (fake "order ready", phishing). | Insert for another user succeeded. |
| 6 | MEDIUM | Signed-out visitors can call claim_due_timetable_reminders(): it marks reminders as sent (real ones are skipped) and returns students' class details. | anon has EXECUTE. |
| 7 | MEDIUM | stores is readable by everyone (signed out too) with all columns, including the manager's personal email/phone/name, commission_percent, rejection and archive reasons. | Column list + "select all" policy. |
| 8 | LOW | Promo codes are readable by everyone, signed out too (1 code live). | Signed-out read 1 code. |
| 9 | LOW | settings (legacy global opening hours) can be changed by ANY manager. | Policy has no shop check. |
| 10 | LOW | Customers can change any column of their saved cards, incl. the Paystack authorization code (Paystack ties codes to the owner's email, so impact is low). | Update ran. |
| 11 | LOW | developer_request_status(email) is callable signed out: anyone can check whether an email applied. | anon EXECUTE. |
| 12 | LOW (performance) | 40 foreign keys have no index (e.g. group_orders.store_id/leader_id, inventory_movements.menu_item_id, orders.collected_by). No effect at 24 MB. | Catalogue query. |
| 13 | INFO | Dormant driver/dispatcher roles still appear in orders/reviews policies. No such accounts exist and the role can't be self-assigned. | Roles: customer 3, manager 3, kitchen 2, developer 1. |

## Checked and found correct

- Card payments: orders are created only by finalize_paystack_checkout() (server-only) after Paystack verification by paystack-verify or the SIGNED webhook; amount and currency compared; duplicate webhooks idempotent. Group share payments use the same path (tested end to end).
- Customers cannot update their own orders afterwards, cannot read others' orders, cannot insert refund requests directly, cannot change shop ratings.
- Refund decisions need the shop's process_refunds permission (+ MFA for staff); card refunds only through Paystack functions.
- Price, extras and stock re-validated on insert (validate_order_pricing); shop hours and sold-out (enforce_ordering_rules).
- Duplicate cash orders after a timeout: client_request_id unique per customer.
- Login lockout: server-side, 3 tries / 3 minutes.
- All privileged functions pin search_path; those callable by signed-in users check the caller's role/shop.
- Stock never negative; stock RPCs write a movement row in the same transaction.
- Query load: heaviest statements are API schema reloads after deployments, not app traffic; the reminder job runs at ~6 ms.

## Not verified

- Backups: depends on the Supabase plan (Free plan has no point-in-time recovery). Check Dashboard > Database > Backups. A restore has never been tested; must be done in a separate project.
- Load capacity: no new load test in this audit. Claims about hundreds of simultaneous orders need a staged test on a copy.
- Existing storage files were not inspected one by one.

## Remediation plan

Phase 1 - security fixes (local first, live with approval)
1. Orders created by people are always unpaid cash orders (#1): on insert by a person, payment method must be cash, payment_status pending, status received/preparing, server-only fields cleared, platform fee recalculated. No app change needed.
2. Profile self-edits limited to personal fields (#3, #4): role, store_id, active, status, rejection_reason, driver_status, email only changeable by the developer (or a manager for their own kitchen logins).
3. Private profile data only to those who need it (#2): own; developer; shop staff see their shop's staff and customers who ordered from their shop.
4. Notifications (#5): yourself; shop staff to customers with an order at their shop; developer anyone.
5. Server-only functions (#6, #11): claim_due_timetable_reminders server only; developer_request_status signed-in only.
6. Saved cards (#10): only the default flag can be changed.

Phase 2 - privacy and correctness (small app changes)
7. Public shop view without manager contact details/commission (#7).
8. Decide on promo code visibility (#8).
9. Restrict or retire the legacy settings table (#9).
10. Remove dormant driver/dispatcher access (#13).

Phase 3 - performance and resilience
11. Indexes for hot foreign keys (#12), measured before/after.
12. Staged load test on a copy with synthetic data and Paystack test mode.
13. Retention clean-up for login attempts, join attempts, expired checkout sessions, reminder records, old read notifications. Orders, payments, refunds and audit records kept.
14. Confirm backups and test a restore in a separate project.

Not recommended now: moving orders.items / status_history from JSON to tables (written once, validated; high risk across 3 apps for little gain at this size).

## Rollback
Each Phase 1 change is a new SQL file that only adds or replaces triggers, policies and grants, with a matching rollback file restoring the exact previous definitions captured from production.
