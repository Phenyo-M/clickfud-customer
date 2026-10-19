-- ============================================================
-- NEW (2026-09-28) — RLS performance: evaluate auth/role helpers ONCE
-- per query instead of once per row.
--
-- Found by load testing a local copy of this database (20k students,
-- 100k orders): policies written as
--     customer_id = auth.uid() or current_role() = 'developer' ...
-- make Postgres call auth.uid()/current_role()/current_status()/
-- current_store_id() for EVERY row it looks at. current_role() etc. are
-- security-definer lookups into profiles, so one student's "my orders"
-- cost ~3.5s (1.2M buffer reads) and an anonymous page load's reviews
-- query ~0.4s — just to return a handful of rows (or none).
--
-- Wrapping each call as (select auth.uid()) turns it into an InitPlan
-- that runs once per statement. This is Supabase's own documented fix
-- (Database Advisor lint "auth_rls_initplan"). The functions don't
-- depend on the row, so every policy returns exactly the same rows as
-- before — verified on the local copy for customer/manager/kitchen/
-- driver/dispatcher/developer/anon identities across every table.
--
-- How: rewrites each existing policy's USING / WITH CHECK in place with
-- ALTER POLICY (no drop, no gap in protection). Idempotent: already-
-- wrapped calls are unwrapped first, then wrapped once. Safe to re-run
-- after any future migration adds new policies.
-- ============================================================
do $$
declare
  p record;
  new_qual text;
  new_check text;
  fn text;
  -- each entry: regex matching the (possibly schema-qualified) call | replacement
  fns text[] := array[
    'auth\.uid\(\)|auth.uid()',
    'auth\.role\(\)|auth.role()',
    'auth\.jwt\(\)|auth.jwt()',
    '(?:public\.)?"current_role"\(\)|public."current_role"()',
    '(?:public\.)?current_status\(\)|public.current_status()',
    '(?:public\.)?current_store_id\(\)|public.current_store_id()'
  ];
  pat text;
  rep text;
  changed int := 0;
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname in ('public', 'storage')
  loop
    new_qual := p.qual;
    new_check := p.with_check;
    foreach fn in array fns loop
      pat := split_part(fn, '|', 1);
      rep := split_part(fn, '|', 2);
      -- 1) unwrap anything already wrapped:  ( SELECT auth.uid() AS uid)  ->  auth.uid()
      new_qual  := regexp_replace(new_qual,  '\(\s*SELECT\s+(' || pat || ')\s+AS\s+"?\w+"?\s*\)', rep, 'gi');
      new_check := regexp_replace(new_check, '\(\s*SELECT\s+(' || pat || ')\s+AS\s+"?\w+"?\s*\)', rep, 'gi');
      -- 2) wrap every call exactly once
      new_qual  := regexp_replace(new_qual,  pat, '(select ' || rep || ')', 'g');
      new_check := regexp_replace(new_check, pat, '(select ' || rep || ')', 'g');
    end loop;

    if new_qual is distinct from p.qual or new_check is distinct from p.with_check then
      if new_qual is not null and new_check is not null then
        execute format('alter policy %I on %I.%I using (%s) with check (%s)', p.policyname, p.schemaname, p.tablename, new_qual, new_check);
      elsif new_qual is not null then
        execute format('alter policy %I on %I.%I using (%s)', p.policyname, p.schemaname, p.tablename, new_qual);
      else
        execute format('alter policy %I on %I.%I with check (%s)', p.policyname, p.schemaname, p.tablename, new_check);
      end if;
      changed := changed + 1;
    end if;
  end loop;
  raise notice 'rls_performance: % policies rewritten', changed;
end $$;
