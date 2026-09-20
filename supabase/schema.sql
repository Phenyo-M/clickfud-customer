-- ============================================================================
-- CLICKFUD — Supabase schema, RLS policies, triggers, realtime, seed data
-- Run this ONCE in the Supabase SQL Editor (Project > SQL Editor > New query).
-- Safe to re-run: tables use IF NOT EXISTS, seed rows are guarded, demo-user
-- seeding checks for existing emails first.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- TABLES
-- ----------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  email text,
  role text not null default 'customer' check (role in ('customer','manager','kitchen','cashier','driver','developer')),
  phone text,
  avatar_url text,
  default_location jsonb,
  driver_status text default 'offline' check (driver_status in ('available','busy','offline')),
  created_at timestamptz not null default now()
);

-- Multi-vendor marketplace: every menu item, order, and manager/kitchen/
-- cashier profile belongs to exactly one store. Customers and drivers are
-- platform-level (not tied to a single store).
create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  manager_id uuid references public.profiles(id),
  name text not null unique,
  slug text unique,
  description text not null default '',
  category text not null default '',
  logo_url text,
  cover_image_url text,
  contact_phone text,
  contact_email text,
  campus_location text not null default '',
  accepts_delivery boolean not null default true,
  accepts_collection boolean not null default true,
  delivery_fee numeric(10,2) not null default 10 check (delivery_fee >= 0),
  prep_time_min int not null default 10 check (prep_time_min >= 0),
  prep_time_max int not null default 25 check (prep_time_max >= 0),
  rating numeric(2,1) not null default 0,
  rating_count int not null default 0,
  opening_time time not null default '08:00',
  closing_time time not null default '21:00',
  closed_days int[] not null default '{}',
  store_closed boolean not null default false,
  closure_reason text,
  status text not null default 'approved' check (status in ('pending','approved','rejected')),
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists store_id uuid references public.stores(id);

create or replace function public.touch_store_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_stores_updated_at on public.stores;
create trigger trg_stores_updated_at
  before update on public.stores
  for each row execute procedure public.touch_store_updated_at();

-- A manager can create/edit their own store, but approving it is a platform
-- decision, not a self-service one — force new stores to 'pending' and lock
-- the status field so only the developer role can move it to
-- approved/rejected (mirrors the prevent_role_change pattern on profiles).
create or replace function public.enforce_store_status()
returns trigger
language plpgsql
as $$
begin
  -- auth.uid() is null for direct SQL (seed data, SQL Editor fixes run as
  -- the table owner) — only enforce this for real API calls made as an
  -- authenticated app user.
  if auth.uid() is null then
    return new;
  end if;
  if TG_OP = 'INSERT' then
    if public.current_role() is distinct from 'developer' then
      new.status := 'pending';
    end if;
  elsif TG_OP = 'UPDATE' then
    if new.status is distinct from old.status and public.current_role() is distinct from 'developer' then
      -- The one self-service transition a non-developer owner may make:
      -- resubmitting a rejected application for another review.
      if not (old.status = 'rejected' and new.status = 'pending') then
        new.status := old.status;
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_store_status on public.stores;
create trigger trg_enforce_store_status
  before insert or update on public.stores
  for each row execute procedure public.enforce_store_status();

-- Store-purchased promotional placements (shown in the homepage "Promotions"
-- carousel) — distinct from public.promotions, which is customer-facing
-- discount CODES entered at checkout. This is store advertising, not a
-- coupon: title/badge/image + an optional date window + priority ordering.
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

create table if not exists public.menu_items (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  category text not null check (category in ('Breakfast','Lunch','Dinner','Snacks','Drinks','Desserts','Specials')),
  price numeric(10,2) not null check (price >= 0),
  image text,
  description text default '',
  ingredients text[] default '{}',
  allergens text[] default '{}',
  preparation_time int default 15 check (preparation_time >= 0),
  available boolean not null default true,
  stock int not null default 50 check (stock >= 0),
  low_stock_threshold int not null default 10 check (low_stock_threshold >= 0),
  rating numeric(2,1) not null default 0,
  rating_count int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.menu_items add column if not exists store_id uuid references public.stores(id);
create index if not exists idx_menu_items_store on public.menu_items(store_id);

create table if not exists public.delivery_zones (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  fee numeric(10,2) not null default 0 check (fee >= 0)
);

create table if not exists public.promotions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  type text not null check (type in ('percentage','fixed')),
  value numeric(10,2) not null check (value >= 0),
  active boolean not null default true,
  expires_at timestamptz,
  usage_limit int,
  used_count int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  opening_time time not null default '08:00',
  closing_time time not null default '21:00',
  closed_days int[] not null default '{}',
  store_closed boolean not null default false,
  closure_reason text,
  low_stock_threshold int not null default 10
);

create sequence if not exists public.order_number_seq start 1;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text unique,
  customer_id uuid not null references public.profiles(id),
  items jsonb not null default '[]',
  subtotal numeric(10,2) not null default 0,
  delivery_fee numeric(10,2) not null default 0,
  discount numeric(10,2) not null default 0,
  promo_code text,
  total numeric(10,2) not null default 0,
  payment_method text not null check (payment_method in ('cod','card')),
  payment_status text not null default 'pending' check (payment_status in ('pending','paid')),
  cash_tendered numeric(10,2),
  delivery_location jsonb not null default '{}',
  assigned_driver uuid references public.profiles(id),
  status text not null default 'received' check (status in ('received','preparing','ready','out_for_delivery','delivered','cancelled')),
  priority text not null default 'normal' check (priority in ('normal','high','urgent')),
  eta timestamptz,
  status_history jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.orders add column if not exists store_id uuid references public.stores(id);

create index if not exists idx_orders_customer on public.orders(customer_id);
create index if not exists idx_orders_status on public.orders(status);
create index if not exists idx_orders_driver on public.orders(assigned_driver);
create index if not exists idx_orders_store on public.orders(store_id);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  message text not null,
  type text not null default 'info',
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_notifications_user on public.notifications(user_id);

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  customer_id uuid not null references public.profiles(id),
  food_rating int not null check (food_rating between 1 and 5),
  delivery_rating int not null check (delivery_rating between 1 and 5),
  overall_rating int not null check (overall_rating between 1 and 5),
  comment text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_reviews_order on public.reviews(order_id);

-- ----------------------------------------------------------------------------
-- HELPER: current caller's role, bypassing RLS to avoid recursion on profiles
-- ----------------------------------------------------------------------------

create or replace function public.current_role()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.current_store_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select store_id from public.profiles where id = auth.uid();
$$;

-- ----------------------------------------------------------------------------
-- TRIGGER: create a profile row automatically when a new auth user signs up
-- ----------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_id uuid;
  v_role text;
begin
  v_role := coalesce(new.raw_user_meta_data->>'role', 'customer');

  -- Demo accounts carry a "store_name" in their signup metadata so they can
  -- be auto-linked to a pre-seeded demo store regardless of signup order
  -- (the store row always exists first, from this same schema script).
  if new.raw_user_meta_data->>'store_name' is not null then
    select id into v_store_id from public.stores where name = new.raw_user_meta_data->>'store_name';
  end if;

  insert into public.profiles (id, name, email, role, phone, store_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
    new.email,
    v_role,
    new.raw_user_meta_data->>'phone',
    v_store_id
  )
  on conflict (id) do nothing;

  if v_store_id is not null and v_role = 'manager' then
    update public.stores set manager_id = new.id where id = v_store_id and manager_id is null;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ----------------------------------------------------------------------------
-- SECURITY: RLS row policies only restrict which ROWS are touched, not which
-- COLUMNS — without these guards, an authenticated user could bypass the UI
-- and PATCH their own profiles.role to 'manager', or sneak extra column
-- changes into a "cancel my order" request. Lock both down at the DB layer.
-- ----------------------------------------------------------------------------

create or replace function public.prevent_role_change()
returns trigger
language plpgsql
as $$
begin
  if new.role is distinct from old.role then
    new.role := old.role;
  end if;
  -- store_id may be set once (e.g. a manager completing store setup, or a
  -- demo account linking to its seeded store) but never reassigned after —
  -- otherwise a compromised account could self-reassign into another store.
  if old.store_id is not null and new.store_id is distinct from old.store_id then
    new.store_id := old.store_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_role_change on public.profiles;
create trigger trg_prevent_role_change
  before update on public.profiles
  for each row execute procedure public.prevent_role_change();

create or replace function public.protect_order_updates()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_role() not in ('manager','kitchen','cashier','driver') then
    -- Non-staff callers may only move their own order to 'cancelled'; every
    -- other column is forced back to its previous value regardless of what
    -- the request body contained.
    new.customer_id := old.customer_id;
    new.items := old.items;
    new.subtotal := old.subtotal;
    new.delivery_fee := old.delivery_fee;
    new.discount := old.discount;
    new.promo_code := old.promo_code;
    new.total := old.total;
    new.payment_method := old.payment_method;
    new.payment_status := old.payment_status;
    new.cash_tendered := old.cash_tendered;
    new.delivery_location := old.delivery_location;
    new.assigned_driver := old.assigned_driver;
    new.priority := old.priority;
    new.eta := old.eta;
    new.order_number := old.order_number;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_order_updates on public.orders;
create trigger trg_protect_order_updates
  before update on public.orders
  for each row execute procedure public.protect_order_updates();

-- ----------------------------------------------------------------------------
-- Stock decrement must happen server-side: customers place orders under their
-- own (non-manager) session, and menu_items UPDATE is manager-only by RLS, so
-- the client can never legally decrement stock itself. A SECURITY DEFINER
-- trigger does it atomically and authoritatively on order creation instead.
-- ----------------------------------------------------------------------------

create or replace function public.decrement_menu_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  new_stock int;
begin
  for item in select * from jsonb_array_elements(new.items)
  loop
    select greatest(0, stock - coalesce((item->>'qty')::int, 0)) into new_stock
    from public.menu_items where id = (item->>'menuItemId')::uuid;

    update public.menu_items
    set stock = new_stock, available = (new_stock > 0)
    where id = (item->>'menuItemId')::uuid;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_decrement_menu_stock on public.orders;
create trigger trg_decrement_menu_stock
  after insert on public.orders
  for each row execute procedure public.decrement_menu_stock();

-- Same problem, same fix: a customer's review should roll into that food
-- item's average rating, but menu_items UPDATE is manager-only under RLS.
create or replace function public.apply_review_rating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ord_items jsonb;
  item jsonb;
  mi record;
  new_count int;
  new_rating numeric;
begin
  select items into ord_items from public.orders where id = new.order_id;
  if ord_items is null then
    return new;
  end if;

  for item in select * from jsonb_array_elements(ord_items)
  loop
    select rating, rating_count into mi from public.menu_items where id = (item->>'menuItemId')::uuid;
    if not found then continue; end if;
    new_count := coalesce(mi.rating_count, 0) + 1;
    new_rating := round(((coalesce(mi.rating, 0) * coalesce(mi.rating_count, 0) + new.food_rating)::numeric / new_count), 1);
    update public.menu_items set rating = new_rating, rating_count = new_count
    where id = (item->>'menuItemId')::uuid;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_apply_review_rating on public.reviews;
create trigger trg_apply_review_rating
  after insert on public.reviews
  for each row execute procedure public.apply_review_rating();

-- ----------------------------------------------------------------------------
-- TRIGGERS: order number generation + updated_at bookkeeping
-- ----------------------------------------------------------------------------

create or replace function public.set_order_number()
returns trigger
language plpgsql
as $$
begin
  if new.order_number is null then
    new.order_number := 'ORD-' || extract(year from now())::int || '-' || lpad(nextval('public.order_number_seq')::text, 5, '0');
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_set_order_number on public.orders;
create trigger trg_set_order_number
  before insert on public.orders
  for each row execute procedure public.set_order_number();

create or replace function public.touch_order_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_orders_updated_at on public.orders;
create trigger trg_orders_updated_at
  before update on public.orders
  for each row execute procedure public.touch_order_updated_at();

-- ----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.stores enable row level security;
alter table public.menu_items enable row level security;
alter table public.delivery_zones enable row level security;
alter table public.promotions enable row level security;
alter table public.settings enable row level security;
alter table public.orders enable row level security;
alter table public.notifications enable row level security;
alter table public.reviews enable row level security;

drop policy if exists "profiles select all authenticated" on public.profiles;
create policy "profiles select all authenticated" on public.profiles
  for select using (auth.uid() is not null);

drop policy if exists "profiles insert own" on public.profiles;
create policy "profiles insert own" on public.profiles
  for insert with check (id = auth.uid());

drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles
  for update using (id = auth.uid());

drop policy if exists "stores select all" on public.stores;
create policy "stores select all" on public.stores
  for select using (
    status = 'approved' or manager_id = auth.uid() or public.current_role() = 'developer'
  );

drop policy if exists "stores insert own" on public.stores;
create policy "stores insert own" on public.stores
  for insert with check (manager_id = auth.uid() and public.current_role() = 'manager');

drop policy if exists "stores update own" on public.stores;
create policy "stores update own" on public.stores
  for update using (manager_id = auth.uid());

drop policy if exists "stores update developer" on public.stores;
create policy "stores update developer" on public.stores
  for update using (public.current_role() = 'developer');

alter table public.store_promotions enable row level security;

drop policy if exists "store_promotions select" on public.store_promotions;
create policy "store_promotions select" on public.store_promotions
  for select using (
    (active = true and (start_date is null or start_date <= now()) and (end_date is null or end_date > now()))
    or exists (select 1 from public.stores s where s.id = store_promotions.store_id and s.manager_id = auth.uid())
  );

drop policy if exists "store_promotions manager write" on public.store_promotions;
create policy "store_promotions manager write" on public.store_promotions
  for all
  using (exists (select 1 from public.stores s where s.id = store_promotions.store_id and s.manager_id = auth.uid()))
  with check (exists (select 1 from public.stores s where s.id = store_promotions.store_id and s.manager_id = auth.uid()));

drop policy if exists "menu select all" on public.menu_items;
create policy "menu select all" on public.menu_items
  for select using (true);

drop policy if exists "menu manager write" on public.menu_items;
create policy "menu manager write" on public.menu_items
  for all
  using (public.current_role() = 'manager' and store_id = public.current_store_id())
  with check (public.current_role() = 'manager' and store_id = public.current_store_id());

drop policy if exists "zones select all" on public.delivery_zones;
create policy "zones select all" on public.delivery_zones
  for select using (true);

drop policy if exists "zones manager write" on public.delivery_zones;
create policy "zones manager write" on public.delivery_zones
  for all using (public.current_role() = 'manager') with check (public.current_role() = 'manager');

drop policy if exists "promos select all" on public.promotions;
create policy "promos select all" on public.promotions
  for select using (true);

drop policy if exists "promos manager write" on public.promotions;
create policy "promos manager write" on public.promotions
  for all using (public.current_role() = 'manager') with check (public.current_role() = 'manager');

drop policy if exists "settings select all" on public.settings;
create policy "settings select all" on public.settings
  for select using (true);

drop policy if exists "settings manager write" on public.settings;
create policy "settings manager write" on public.settings
  for all using (public.current_role() = 'manager') with check (public.current_role() = 'manager');

drop policy if exists "orders select" on public.orders;
create policy "orders select" on public.orders
  for select using (
    customer_id = auth.uid()
    or public.current_role() = 'driver'
    or (public.current_role() in ('manager','kitchen','cashier') and store_id = public.current_store_id())
  );

drop policy if exists "orders insert own" on public.orders;
create policy "orders insert own" on public.orders
  for insert with check (customer_id = auth.uid());

drop policy if exists "orders customer cancel" on public.orders;
create policy "orders customer cancel" on public.orders
  for update
  using (customer_id = auth.uid() and status = 'received')
  with check (customer_id = auth.uid() and status = 'cancelled');

drop policy if exists "orders staff update" on public.orders;
create policy "orders staff update" on public.orders
  for update
  using (
    public.current_role() = 'driver'
    or (public.current_role() in ('manager','kitchen','cashier') and store_id = public.current_store_id())
  );

drop policy if exists "notif select own" on public.notifications;
create policy "notif select own" on public.notifications
  for select using (user_id = auth.uid());

drop policy if exists "notif update own" on public.notifications;
create policy "notif update own" on public.notifications
  for update using (user_id = auth.uid());

drop policy if exists "notif insert authenticated" on public.notifications;
create policy "notif insert authenticated" on public.notifications
  for insert with check (auth.uid() is not null);

drop policy if exists "reviews select" on public.reviews;
create policy "reviews select" on public.reviews
  for select using (
    customer_id = auth.uid()
    or public.current_role() = 'driver'
    or (
      public.current_role() in ('manager','kitchen','cashier')
      and exists (
        select 1 from public.orders o
        where o.id = reviews.order_id and o.store_id = public.current_store_id()
      )
    )
  );

drop policy if exists "reviews insert own" on public.reviews;
create policy "reviews insert own" on public.reviews
  for insert with check (customer_id = auth.uid());

-- ----------------------------------------------------------------------------
-- REALTIME: broadcast changes so every open dashboard/tab updates live
-- ----------------------------------------------------------------------------

do $$
begin
  alter publication supabase_realtime add table public.orders;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.notifications;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.menu_items;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.reviews;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.stores;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.store_promotions;
exception when duplicate_object then null;
end $$;

-- ----------------------------------------------------------------------------
-- SEED DATA — menu, zones, promotions, settings (no auth complexity, safe)
-- ----------------------------------------------------------------------------

insert into public.settings (id, opening_time, closing_time, closed_days, store_closed, low_stock_threshold)
values (1, '08:00', '21:00', '{}', false, 10)
on conflict (id) do nothing;

insert into public.delivery_zones (name, fee) values
  ('Residence A', 10.00),
  ('Residence B', 12.00),
  ('Library', 8.00),
  ('Student Centre', 5.00),
  ('Faculty Building', 10.00),
  ('Sports Centre', 15.00)
on conflict (name) do nothing;

insert into public.promotions (code, type, value, active, usage_limit, used_count) values
  ('CAMPUS10', 'percentage', 10, true, null, 0),
  ('WELCOME20', 'fixed', 20, true, 100, 0)
on conflict (code) do nothing;

-- Three demo stores. manager_id stays null until the matching demo manager
-- signs up (see handle_new_user's store_name auto-link).
insert into public.stores (name, description, category, campus_location, cover_image_url, logo_url, delivery_fee, prep_time_min, prep_time_max, rating, rating_count) values
  ('Campus Grill', 'Burgers, chicken and hearty campus favourites.', 'Fast Food', 'South Campus', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=1200&q=60', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=200&q=60', 10.00, 15, 25, 4.6, 0),
  ('Kota Republic', 'Durban-style bunny chow, kotas and local favourites.', 'Local Food', 'Student Centre', 'https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?auto=format&fit=crop&w=1200&q=60', 'https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?auto=format&fit=crop&w=200&q=60', 8.00, 15, 25, 4.7, 0),
  ('Brew & Bake', 'Coffee, breakfast and fresh-baked treats.', 'Coffee & Bakery', 'Library', 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=1200&q=60', 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=200&q=60', 6.00, 8, 15, 4.5, 0)
on conflict (name) do nothing;

insert into public.store_promotions (store_id, title, message, badge, image_url, promo_type, active, priority) values
  ((select id from public.stores where name = 'Kota Republic'), 'New Kota Flavours', 'Bigger. Juicier. Better.', 'New Menu', 'https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?auto=format&fit=crop&w=1000&q=60', 'new_menu', true, 2),
  ((select id from public.stores where name = 'Brew & Bake'), 'Iced Coffee Deal', 'R25 instead of R35, all week.', 'Special Offer', 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=1000&q=60', 'special_offer', true, 1),
  ((select id from public.stores where name = 'Campus Grill'), 'Meal Deal Monday', 'Burger, chips and a drink — one low price.', 'Meal Deal', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=1000&q=60', 'discount', true, 0)
on conflict (store_id, title) do nothing;

insert into public.menu_items (name, category, price, image, description, ingredients, allergens, preparation_time, available, stock, rating, rating_count) values
  ('Full English Breakfast', 'Breakfast', 45.00, 'https://images.unsplash.com/photo-1533089860892-a7c6f0a88666?auto=format&fit=crop&w=800&q=60', 'Eggs, bacon, sausage, grilled tomato and toast.', array['Eggs','Bacon','Sausage','Tomato','Toast'], array['Gluten','Egg'], 15, true, 40, 4.5, 32),
  ('Bacon & Egg Roll', 'Breakfast', 35.00, 'https://images.unsplash.com/photo-1550507992-eb63ffee0847?auto=format&fit=crop&w=800&q=60', 'Crispy bacon and fried egg in a soft bread roll.', array['Bacon','Egg','Bread Roll'], array['Gluten','Egg'], 10, true, 35, 4.3, 21),
  ('Beef Burger & Chips', 'Lunch', 55.00, 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=800&q=60', 'Juicy beef patty, cheese, lettuce and tomato with a side of chips.', array['Beef Patty','Cheese','Lettuce','Tomato','Bun','Chips'], array['Gluten','Dairy'], 18, true, 30, 4.7, 58),
  ('Chicken Burger & Chips', 'Lunch', 50.00, 'https://images.unsplash.com/photo-1571091718767-18b5b1457add?auto=format&fit=crop&w=800&q=60', 'Grilled chicken fillet burger with a side of chips.', array['Chicken','Lettuce','Mayo','Bun','Chips'], array['Gluten','Egg'], 18, true, 30, 4.4, 40),
  ('Margherita Pizza', 'Lunch', 75.00, 'https://images.unsplash.com/photo-1604068549290-dea0e4a305ca?auto=format&fit=crop&w=800&q=60', 'Classic tomato, mozzarella and basil on a hand-tossed base.', array['Tomato','Mozzarella','Basil','Dough'], array['Gluten','Dairy'], 20, true, 25, 4.6, 47),
  ('Chicken & Chips', 'Lunch', 60.00, 'https://images.unsplash.com/photo-1626645738196-c2a7c87a8f58?auto=format&fit=crop&w=800&q=60', 'Two pieces of fried chicken with golden chips.', array['Chicken','Chips'], array[]::text[], 16, true, 28, 4.5, 36),
  ('Beef Bunny Chow', 'Specials', 65.00, 'https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?auto=format&fit=crop&w=800&q=60', 'Durban-style beef curry served in a hollowed-out bread loaf.', array['Beef','Curry Sauce','Bread'], array['Gluten'], 20, true, 20, 4.8, 29),
  ('Grilled Chicken Wrap', 'Dinner', 58.00, 'https://images.unsplash.com/photo-1626700051175-6818013e1d4f?auto=format&fit=crop&w=800&q=60', 'Grilled chicken, salad and sauce rolled in a soft wrap.', array['Chicken','Lettuce','Tomato','Wrap'], array['Gluten'], 15, true, 22, 4.3, 18),
  ('Beef Lasagne', 'Dinner', 70.00, 'https://images.unsplash.com/photo-1619895092538-128341789043?auto=format&fit=crop&w=800&q=60', 'Layers of pasta, beef ragu and cheese sauce, oven-baked.', array['Pasta','Beef','Cheese','Tomato Sauce'], array['Gluten','Dairy'], 22, true, 18, 4.6, 25),
  ('Vegetable Samosas (4)', 'Snacks', 25.00, 'https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=800&q=60', 'Crispy pastry parcels filled with spiced vegetables.', array['Pastry','Mixed Vegetables','Spices'], array['Gluten'], 8, true, 45, 4.2, 15),
  ('Chocolate Muffin', 'Snacks', 18.00, 'https://images.unsplash.com/photo-1607958996333-41aef7caefaa?auto=format&fit=crop&w=800&q=60', 'Soft, rich double-chocolate muffin.', array['Flour','Cocoa','Chocolate Chips'], array['Gluten','Dairy','Egg'], 5, true, 50, 4.4, 22),
  ('Chocolate Brownie', 'Desserts', 22.00, 'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?auto=format&fit=crop&w=800&q=60', 'Fudgy chocolate brownie square.', array['Flour','Cocoa','Butter','Sugar'], array['Gluten','Dairy','Egg'], 5, true, 40, 4.6, 19),
  ('Vanilla Milkshake', 'Drinks', 28.00, 'https://images.unsplash.com/photo-1572490122747-3968b75cc699?auto=format&fit=crop&w=800&q=60', 'Thick and creamy vanilla milkshake.', array['Milk','Vanilla Ice Cream'], array['Dairy'], 5, true, 40, 4.5, 27),
  ('Cold Drink 330ml', 'Drinks', 18.00, 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?auto=format&fit=crop&w=800&q=60', 'Ice-cold canned soft drink.', array['Carbonated Water','Sugar'], array[]::text[], 1, true, 100, 4.1, 12)
on conflict (name) do nothing;

-- Assign every existing menu item to one of the three demo stores.
update public.menu_items set store_id = (select id from public.stores where name = 'Campus Grill')
  where name in ('Beef Burger & Chips','Chicken Burger & Chips','Margherita Pizza','Chicken & Chips','Grilled Chicken Wrap','Beef Lasagne') and store_id is null;

update public.menu_items set store_id = (select id from public.stores where name = 'Kota Republic')
  where name in ('Beef Bunny Chow','Vegetable Samosas (4)') and store_id is null;

update public.menu_items set store_id = (select id from public.stores where name = 'Brew & Bake')
  where name in ('Full English Breakfast','Bacon & Egg Roll','Chocolate Muffin','Chocolate Brownie','Vanilla Milkshake','Cold Drink 330ml') and store_id is null;

-- A couple more Kota Republic items so it isn't the thinnest store on launch.
insert into public.menu_items (name, category, price, image, description, ingredients, allergens, preparation_time, available, stock, rating, rating_count, store_id) values
  ('Classic Kota', 'Specials', 40.00, 'https://images.unsplash.com/photo-1626700051175-6818013e1d4f?auto=format&fit=crop&w=800&q=60', 'Hollowed-out quarter loaf with polony, chips, cheese and atchar.', array['Bread','Polony','Chips','Cheese','Atchar'], array['Gluten','Dairy'], 15, true, 30, 4.6, 0, (select id from public.stores where name = 'Kota Republic')),
  ('Kota with Russian', 'Specials', 48.00, 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=800&q=60', 'Classic kota loaded with a russian sausage, chips and sauce.', array['Bread','Russian Sausage','Chips','Sauce'], array['Gluten'], 15, true, 25, 4.7, 0, (select id from public.stores where name = 'Kota Republic'))
on conflict (name) do nothing;

-- ============================================================================
-- Demo accounts are NOT seeded via raw SQL here — direct inserts into
-- auth.users/auth.identities proved unreliable across Supabase versions
-- (observed both a 500 "Database error querying schema" on login, and later
-- silent credential corruption on a second run). Use the app's Dev Nav
-- "Seed Demo Accounts" button instead, which creates them via the public
-- signUp API and is guaranteed to produce accounts GoTrue can authenticate.
-- Manager/kitchen/cashier demo accounts carry a "store_name" in their signup
-- metadata (see App.CONST.DEMO_ACCOUNTS in js/config.js) matching one of the
-- three stores seeded above, so handle_new_user() auto-links their profile
-- (and, for managers, the store's manager_id) to the right store.
--
-- Next steps:
--  1. In Supabase dashboard: Authentication > Providers > Email > turn OFF
--     "Confirm email" (so signup/demo logins work immediately).
--  2. Authentication > Providers: make sure Email provider is enabled.
--  3. Load the app and click "Seed Demo Accounts" in the Dev Nav.
-- ============================================================================
