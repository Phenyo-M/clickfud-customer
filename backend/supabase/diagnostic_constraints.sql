select conrelid::regclass as table_name, conname as constraint_name, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid in ('public.stores'::regclass, 'public.store_promotions'::regclass, 'public.menu_items'::regclass)
and contype = 'u'
order by table_name;
