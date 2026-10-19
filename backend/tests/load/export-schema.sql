-- Read-only: produces the full structure of the public schema as SQL text
-- (no data). Order: types, sequences, tables, functions, views, constraints,
-- indexes, triggers, RLS, policies.
with
types as (
  select string_agg(format('create type public.%I as enum (%s);', t.typname,
           (select string_agg(quote_literal(e.enumlabel), ', ' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid)), E'\n') s
  from pg_type t where t.typnamespace = 'public'::regnamespace and t.typtype = 'e'
),
seqs as (
  select string_agg(format('create sequence if not exists public.%I;', c.relname), E'\n') s
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
),
tables as (
  select string_agg(format('create table public.%I (%s);', c.relname,
           (select string_agg(format('%I %s%s%s', a.attname, format_type(a.atttypid, a.atttypmod),
                     case when a.attnotnull then ' not null' else '' end,
                     case when d.adbin is not null and a.attgenerated = '' then ' default ' || pg_get_expr(d.adbin, d.adrelid)
                          when a.attgenerated = 's' then ' generated always as (' || pg_get_expr(d.adbin, d.adrelid) || ') stored' else '' end), ', ' order by a.attnum)
              from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
             where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)), E'\n' order by c.relname) s
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
),
funcs as (
  select string_agg(pg_get_functiondef(p.oid) || ';', E'\n\n' order by p.proname) s
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p')
    and not exists (select 1 from pg_depend dep where dep.objid = p.oid and dep.deptype = 'e')
),
views as (
  select string_agg(format('create or replace view public.%I as %s', c.relname, pg_get_viewdef(c.oid)), E'\n' order by c.oid) s
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
),
cons as (
  select string_agg(format('alter table %s add constraint %I %s;', con.conrelid::regclass, con.conname, pg_get_constraintdef(con.oid)), E'\n'
           order by case con.contype when 'p' then 1 when 'u' then 2 when 'c' then 3 else 4 end) s
  from pg_constraint con where con.connamespace = 'public'::regnamespace and con.contype in ('p', 'u', 'c', 'f')
),
idx as (
  select string_agg(pg_get_indexdef(i.indexrelid) || ';', E'\n') s
  from pg_index i join pg_class c on c.oid = i.indrelid
  where c.relnamespace = 'public'::regnamespace and not exists (select 1 from pg_constraint con where con.conindid = i.indexrelid)
),
trg as (
  select string_agg(pg_get_triggerdef(t.oid) || ';', E'\n') s
  from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
),
rls as (
  select string_agg(format('alter table public.%I enable row level security;', c.relname), E'\n') s
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relrowsecurity
),
pol as (
  select string_agg(format('create policy %I on public.%I as %s for %s to %s%s%s;', policyname, tablename, permissive, cmd,
           array_to_string(roles, ', '),
           case when qual is not null then ' using (' || qual || ')' else '' end,
           case when with_check is not null then ' with check (' || with_check || ')' else '' end), E'\n') s
  from pg_policies where schemaname = 'public'
)
select json_build_object('types', (select s from types), 'seqs', (select s from seqs), 'tables', (select s from tables),
  'funcs', (select s from funcs), 'views', (select s from views), 'cons', (select s from cons), 'idx', (select s from idx),
  'trg', (select s from trg), 'rls', (select s from rls), 'pol', (select s from pol)) r;
