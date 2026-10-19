# ClickFood audit and fixes, 4–5 October 2026

Follows the database audit of 2 October (`docs/database-audit-2026-10-02.md`). Scope: the live Supabase project, the customer, manager (staff) and developer apps, and the Edge Functions. Every fix was proven before going live, either on the live database inside a transaction that was undone, or locally against live data.

## Fixed and live

| # | Severity | Problem | Fix | Evidence |
|---|---|---|---|---|
| 1 | Critical | A signed-in student could create an order already marked "paid by card" and "ready", without paying. | New database rule (`trg_aa_guard_customer_order_insert`): an order created by a person is always an unpaid cash order. Fields only the server may set are cleared. ClickFood's fee is worked out from the live menu. Card orders still come only from the server after PayFast confirms. | Live test: card/paid insert refused; a cash order with fake values was saved as pending/preparing. |
| 2 | High | Any signed-in user could read every user's email, phone and student number. | Profiles are visible to: the person themselves; the developer; a shop's manager and kitchen staff for their own staff and their own customers. | Live test: a customer sees 1 profile (their own); a manager sees their customers only; the developer sees all. |
| 3 | High | A student could link themselves to any shop and see its unapproved menu and storage folder. | Linking to a shop is only allowed for the shop's own manager (shop registration still works). | Live test: both cases. |
| 4 | High | A deactivated account could switch itself back on (own `active`/`status`). | Only the developer changes those; a manager can switch their own kitchen staff on or off. | Live test. |
| 5 | Medium | Anyone signed in could send any user a notification (fake "order ready"). | Allowed: yourself; the developer anyone; shop staff only to customers who ordered at their shop. | Live test: forged ones refused, app notifications still work. |
| 6 | Medium | Signed-out visitors could run the timetable reminder function (marks reminders sent, returns class details). | Server only. | Live test: permission denied. |
| 7 | Low | Signed-out visitors could check whether an email applied as a developer. | Signed-in only. | Live test. |
| 8 | Low | Customers could edit any field of a saved card record. | Only the "default" flag. | Live test. |
| 9 | High (cost/speed) | Opening the home page downloaded 13.2 MB. Six uploads were huge PNGs: logos of 1.5–1.9 MB shown at ~48 px, and 3.4 MB photos. Uploads skipped compression for PNG files. | The 6 images were re-compressed to WebP as new files; originals kept; database points at the copies. Uploads now convert PNG to WebP (keeps transparency) with the same size cap; logos are capped at 512 px. | First load **13.2 MB → 3.0 MB**; network idle 11.4 s → 3.1 s (one run, same connection). Side-by-side check: no visible quality loss. |
| 10 | Medium (speed) | Opening the app redrew the whole page ~17 times (~1.2 s of a frozen screen at mid-range phone speed). | The data loaded at start-up is saved together and drawn once (at most 1.5 s held; navigation always draws immediately). | At phone CPU speed: first visit 17 → 10 redraws (1185 → 746 ms); return visit 4 redraws (296 ms). |
| 11 | Low (speed) | 49 links between tables had no index. | 24 indexes added on the links the apps filter or join on. The rest are "who did this" stamps nothing looks up. | Catalogue recount. |
| 13 | **High** | **Simultaneous orders lost stock updates and deadlocked** (found by the 200-order load test). 200 orders of one item lowered stock by only 16; 14 of 200 mixed orders failed with deadlocks. | `supabase/stock_concurrency_fix.sql`: items are locked in a fixed order before stock changes; a cash order that would oversell is refused with the usual "Only N left"; paid card orders are never refused. Ingredient usage also in fixed order. | Local copy of the live structure: before 186/200 ok, stock wrong; after 200/200 in each burst, stock exact, 0 deadlocks, p95 0.54 s (was 3.4 s); sell-out: exactly 50 of 200 sold. |
| 12 | Medium | The empty space under pages on a PC, the hero image flashing on refresh, and a checkout button overflowing its box (fixed earlier in this session). | | Browser checks. |

## Payments (PayFast), checked this session

- Orders are created only after PayFast's notification passes four checks: signature, merchant id, PayFast's own confirmation, and amount, checked again in the database under a row lock.
- Duplicate or late notifications never create a second order.
- A second, separate payment is recorded and refunded.
- The return from PayFast proves nothing on its own.
- 67 local end-to-end tests pass, and a real sandbox payment worked on 2026-10-04.

## Not changed (needs a decision or more work)

| Item | Why it's open | Suggested next step |
|---|---|---|
| Shop records show the manager's personal email/phone and commission to everyone (finding 7). | The apps read shop records with "all columns", so hiding columns needs a public view and app changes in all three apps. | A `stores_public` view without those columns, used by the customer app. |
| Promo codes are readable while signed out. | Product decision: should codes be secret? | Decide; then a server check instead of reading the table. |
| Legacy `settings` table editable by any manager. | Need to confirm nothing still reads it. | Make it developer-only, or retire it. |
| Dormant driver/dispatcher rules in order policies. | No such accounts; harmless now. | Remove when touching those policies next. |
| 6 unused script files in the customer app folder (old copies of the manager, kitchen, cashier, delivery and developer pages, and `audit.js`). | Removing files needs your approval. They are never downloaded, so they have no speed effect. | Delete them (they are in git). |
| Old Paystack functions and secret still deployed. | RecessBox still uses them until it moves to PayFast. | Move RecessBox, then delete them. |

## Load test (2026-10-06, local copy of the live structure, laptop)

The test ran on a local copy of the database, with each student using their own login token, so every rule and trigger ran. Results after the fix:
- 200 simultaneous cash orders: 200/200 succeeded.
- 200 orders of the same item: 200/200.
- 200 PayFast confirmations, each sent twice: exactly 200 orders.
- Sell-out (50 left, 200 buyers): exactly 50 sold.
- Stock was exact in every case, with 0 deadlocks; the slowest order took 0.54 s.

This shows the database logic copes with a 200-order burst. It does not prove the live service will. Supabase's hosted compute, connection limits and the network from South Africa are not part of this test.

## Limits that will matter for growth (not yet measured under load)

- **Supabase plan:** the dashboard says the organisation went over its Free plan quota last cycle and will be restricted from 3 Nov 2026. Image downloads (egress) were the heaviest traffic; the image fix cuts that by about 75% per visit. For real traffic, the Pro plan is needed: more egress and database size, daily backups, more Realtime connections.
- **Realtime connections:** each open app keeps one live connection. The Free plan's concurrent limit is far below 10,000 users.
- **Database connections:** 27 of 60 were in use during the 2 October audit.
- **PayFast:** still in sandbox; Live needs your approved merchant account.
- **Vercel:** static hosting, no concern at this size.

No claim is made here about how many users ClickFood supports; that needs a load test.

## Files

**Database (all applied live, each with an undo file or note):**
- `supabase/security_phase1.sql` and `supabase/security_phase1_rollback.sql`
- `supabase/fk_indexes.sql` (undo: drop the listed indexes)
- `supabase/image_recompress_2026-10-04_rollback.sql` (points the 6 images back at their original files)

**Apps:**
- `js/upload.js`, in all 3 apps
- `js/store.js` and `js/app.js` (customer)
- `index.html` version stamps

**Database (2026-10-06):** `supabase/stock_concurrency_fix.sql` + `stock_concurrency_fix_rollback.sql`.

**Tests:** `tests/load/` (order burst load test), `tests/security-check.cjs`. It runs the security checks against the live database in a transaction that is always undone. Run it after any database change.
