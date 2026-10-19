alter table public.profiles add column if not exists store_id uuid references public.stores(id);

alter table public.menu_items add column if not exists store_id uuid references public.stores(id);
create index if not exists idx_menu_items_store on public.menu_items(store_id);

alter table public.orders add column if not exists store_id uuid references public.stores(id);
create index if not exists idx_orders_store on public.orders(store_id);

create table if not exists public.store_promotions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  title text not null,
  message text not null default '',
  badge text not null default 'Featured',
  image_url text,
  promo_type text not null default 'featured' check (promo_type in ('featured','new_menu','special_offer','discount','new_store')),
  start_date timestamptz,
  end_date timestamptz,
  active boolean not null default true,
  priority int not null default 0,
  created_at timestamptz not null default now(),
  unique (store_id, title)
);
create index if not exists idx_store_promotions_store on public.store_promotions(store_id);
