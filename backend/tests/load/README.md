# Order burst load test (local only, never production)

1. `export-schema.sql`: run read-only against live to export the structure (no data):
   `npx supabase db query --project-ref ctxnwjjpqxecidzblyok --linked -o json -f tests/load/export-schema.sql > schema-export.json`
2. `build-db.cjs`: builds a local Postgres copy from that export (needs `embedded-postgres`, `pg` and a PostgREST binary; paths are set at the top of the file).
3. `order-burst.cjs`: 200 students order at once through PostgREST with their own login tokens, so every rule and trigger runs. Four scenarios:
   - A: spread orders;
   - B: everyone orders the same item;
   - C: 200 PayFast confirmations, each sent twice;
   - D: sell-out (50 left, 200 buyers).

   It checks order counts, stock, duplicates and deadlocks. Set `FIX=<file.sql>` to try a change first.

Results 2026-10-06 (laptop, PostgREST pool 15):
- before `supabase/stock_concurrency_fix.sql`: A 186/200 ok with 14 deadlocks, and stock lost (B: 200 sold, stock down 16);
- after: A, B and C all ok, stock exact, 0 deadlocks, p95 under 0.6 s; D sold exactly 50.
