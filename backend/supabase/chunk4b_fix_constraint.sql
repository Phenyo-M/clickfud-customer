do $$
begin
  alter table public.store_promotions add constraint store_promotions_store_id_title_key unique (store_id, title);
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.stores add constraint stores_name_key unique (name);
exception when duplicate_object then null;
end $$;
