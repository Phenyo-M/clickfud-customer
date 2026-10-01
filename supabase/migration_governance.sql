-- ============================================================
-- 1. Stores: business-registration fields + archive/delete support
-- ============================================================
alter table public.stores add column if not exists is_registered_business boolean;
alter table public.stores add column if not exists registration_date date;
alter table public.stores add column if not exists archived_reason text;
alter table public.stores add column if not exists archived_by uuid references public.profiles(id);
alter table public.stores add column if not exists archived_at timestamptz;

alter table public.stores drop constraint if exists stores_status_check;
alter table public.stores add constraint stores_status_check
  check (status in ('pending','approved','rejected','archived'));

drop policy if exists "stores delete developer" on public.stores;
create policy "stores delete developer" on public.stores
  for delete using (public.current_role() = 'developer');

-- ============================================================
-- 2. Audit log for developer actions (approve/reject/archive/delete)
-- ============================================================
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id),
  actor_name text,
  action text not null,
  target_type text not null,
  target_id uuid,
  target_name text,
  reason text,
  created_at timestamptz not null default now()
);

alter table public.audit_log enable row level security;

drop policy if exists "audit_log select developer" on public.audit_log;
create policy "audit_log select developer" on public.audit_log
  for select using (public.current_role() = 'developer');

drop policy if exists "audit_log insert own" on public.audit_log;
create policy "audit_log insert own" on public.audit_log
  for insert with check (actor_id = auth.uid() and public.current_role() = 'developer');

-- ============================================================
-- 3. Store promotions: require developer approval before going live
-- ============================================================
alter table public.store_promotions add column if not exists status text not null default 'pending';
alter table public.store_promotions drop constraint if exists store_promotions_status_check;
alter table public.store_promotions add constraint store_promotions_status_check
  check (status in ('pending','approved','rejected'));

drop policy if exists "store_promotions select" on public.store_promotions;
create policy "store_promotions select" on public.store_promotions
  for select using (
    (status = 'approved' and active = true and (start_date is null or start_date <= now()) and (end_date is null or end_date > now()))
    or exists (select 1 from public.stores s where s.id = store_promotions.store_id and s.manager_id = auth.uid())
    or public.current_role() = 'developer'
  );

-- ============================================================
-- 4. Orders: require the target store to be approved (not archived/
--    pending/rejected) at insert time — defense in depth beyond RLS
--    already hiding non-approved stores from customer browsing.
--    Also drops the removed Cashier role from staff visibility.
-- ============================================================
drop policy if exists "orders insert own" on public.orders;
create policy "orders insert own" on public.orders
  for insert with check (
    customer_id = auth.uid()
    and exists (select 1 from public.stores s where s.id = orders.store_id and s.status = 'approved')
  );

drop policy if exists "orders select" on public.orders;
create policy "orders select" on public.orders
  for select using (
    customer_id = auth.uid()
    or public.current_role() = 'driver'
    or (public.current_role() in ('manager','kitchen') and store_id = public.current_store_id())
  );

drop policy if exists "orders staff update" on public.orders;
create policy "orders staff update" on public.orders
  for update
  using (
    public.current_role() = 'driver'
    or (public.current_role() in ('manager','kitchen') and store_id = public.current_store_id())
  );

-- ============================================================
-- 5. University / college: customers browse only shops at their own
--    university; shops declare which university they belong to.
-- ============================================================
alter table public.profiles add column if not exists university text;
alter table public.stores add column if not exists university text;

-- Whether any 'developer' (platform-admin) profile already exists —
-- exposed to anon/authenticated so a not-yet-logged-in visitor's signup
-- form can tell whether the one-time admin bootstrap is still open.
-- Reveals nothing sensitive (just a boolean), unlike selecting profiles
-- directly, which RLS blocks for logged-out visitors anyway.
create or replace function public.developer_exists()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.profiles where role = 'developer');
$$;

grant execute on function public.developer_exists() to anon, authenticated;

-- ============================================================
-- 5b. Developer access requests: kept available (e.g. for a future
--     in-app review screen, or a second admin down the line) but no
--     longer the primary path — self-signup is open again below while
--     no developer exists yet, since a manual approve-then-hand-create
--     flow was too much friction for a single-operator project. A
--     request row still never becomes an account automatically.
-- ============================================================
create table if not exists public.developer_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text,
  reason text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id)
);

alter table public.developer_requests enable row level security;

-- Anyone (including logged-out visitors) may submit a request — this is
-- the whole point, it happens before any account exists.
drop policy if exists "developer_requests insert anyone" on public.developer_requests;
create policy "developer_requests insert anyone" on public.developer_requests
  for insert to anon, authenticated with check (true);

-- Only existing developers can see or act on the queue.
drop policy if exists "developer_requests select developer" on public.developer_requests;
create policy "developer_requests select developer" on public.developer_requests
  for select using (public.current_role() = 'developer');

drop policy if exists "developer_requests update developer" on public.developer_requests;
create policy "developer_requests update developer" on public.developer_requests
  for update using (public.current_role() = 'developer');

-- Lets a not-yet-logged-in login screen tell "no account, and no
-- request either" apart from "no account, but a request is pending" —
-- without exposing the full row (name/phone/reason) to an anonymous
-- caller, which a broader select policy would.
create or replace function public.developer_request_status(p_email text)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select status from public.developer_requests
  where lower(email) = lower(p_email)
  order by created_at desc
  limit 1;
$$;

grant execute on function public.developer_request_status(text) to anon, authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_id uuid;
  v_requested_role text;
  v_role text;
begin
  v_requested_role := coalesce(new.raw_user_meta_data->>'role', 'customer');

  -- The role requested at signup is client-supplied and must never be
  -- trusted outright — anyone can call the Supabase Auth signup API
  -- directly, bypassing every app's UI. Only 'customer' and 'manager'
  -- (the two roles any signup form ever actually offers) are honoured
  -- as-is. 'developer' is granted exactly once, to bootstrap the very
  -- first platform admin; after that it silently falls back to
  -- 'customer' and requires manual promotion in Supabase instead.
  -- 'kitchen'/'driver' are never self-service and are downgraded here
  -- too, since no UI offers them but a direct API call still could.
  if v_requested_role = 'developer' then
    if exists (select 1 from public.profiles where role = 'developer') then
      v_role := 'customer';
    else
      v_role := 'developer';
    end if;
  elsif v_requested_role = 'manager' then
    v_role := 'manager';
  else
    v_role := 'customer';
  end if;

  if new.raw_user_meta_data->>'store_name' is not null then
    select id into v_store_id from public.stores where name = new.raw_user_meta_data->>'store_name';
  end if;

  insert into public.profiles (id, name, email, role, phone, store_id, university)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
    new.email,
    v_role,
    new.raw_user_meta_data->>'phone',
    v_store_id,
    new.raw_user_meta_data->>'university'
  )
  on conflict (id) do nothing;

  if v_store_id is not null and v_role = 'manager' then
    update public.stores set manager_id = new.id where id = v_store_id and manager_id is null;
  end if;

  return new;
end;
$$;

-- ============================================================
-- 6. Image uploads: optimized-image metadata table + shop-scoped
--    storage policies (replaces the earlier "any authenticated user
--    can upload anywhere in the bucket" policies from initial setup).
-- ============================================================
create table if not exists public.images (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references public.stores(id) on delete cascade,
  item_id uuid,
  kind text not null check (kind in ('logo','cover','menu_item','promotion')),
  storage_path text not null,
  url text not null,
  original_filename text,
  optimized_filename text,
  original_size int,
  optimized_size int,
  image_format text,
  uploaded_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.images enable row level security;

drop policy if exists "images meta select" on public.images;
create policy "images meta select" on public.images
  for select using (
    images.shop_id = public.current_store_id()
    or public.current_role() = 'developer'
    or exists (select 1 from public.stores s where s.id = images.shop_id and s.status = 'approved')
  );

drop policy if exists "images meta write own shop" on public.images;
create policy "images meta write own shop" on public.images
  for all
  using (images.shop_id = public.current_store_id())
  with check (images.shop_id = public.current_store_id());

update storage.buckets set file_size_limit = 10485760, allowed_mime_types = array['image/jpeg','image/png','image/webp']
  where id = 'images';

-- Replace the original bucket-wide policies with ones scoped to the shop
-- folder in the path (logos/{shop_id}/…, menus/{shop_id}/…, items/{shop_id}/…,
-- promotions/{shop_id}/…) so one manager can never touch another shop's files.
drop policy if exists "authenticated upload images" on storage.objects;
drop policy if exists "authenticated manage own images" on storage.objects;
drop policy if exists "authenticated delete own images" on storage.objects;
drop policy if exists "public read images" on storage.objects;

drop policy if exists "images select scoped" on storage.objects;
create policy "images select scoped" on storage.objects
  for select using (
    bucket_id = 'images' and (
      (storage.foldername(name))[2] = public.current_store_id()::text
      or public.current_role() = 'developer'
      or exists (select 1 from public.stores s where s.id::text = (storage.foldername(name))[2] and s.status = 'approved')
    )
  );

-- These three own-shop policies previously did `exists (select 1 from
-- public.stores s where ... and s.manager_id = auth.uid())` — a raw
-- subquery against an RLS-protected table, evaluated from inside a
-- storage.objects policy. That combination kept silently rejecting valid
-- uploads with a plain "row violates row-level security policy" (no
-- clearer error), even for a manager who genuinely owned the store —
-- confirmed by direct testing after re-applying the migration multiple
-- times with no change. Rewritten to go through current_store_id()
-- instead, the same security-definer helper (schema.sql) every other
-- owner-check policy in this schema already uses specifically to avoid
-- this class of RLS-subquery problem.
drop policy if exists "images insert own shop" on storage.objects;
create policy "images insert own shop" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'images' and
    (storage.foldername(name))[2] = public.current_store_id()::text
  );

drop policy if exists "images update own shop" on storage.objects;
create policy "images update own shop" on storage.objects
  for update to authenticated using (
    bucket_id = 'images' and
    (storage.foldername(name))[2] = public.current_store_id()::text
  );

drop policy if exists "images delete own shop" on storage.objects;
create policy "images delete own shop" on storage.objects
  for delete to authenticated using (
    bucket_id = 'images' and
    (storage.foldername(name))[2] = public.current_store_id()::text
  );

-- ============================================================
-- 6c. store_promotions: the manager-write policy only ever covered the
--     manager themselves (and had the same raw-subquery-against-stores
--     issue as the image policies above) — there was NO policy letting a
--     developer UPDATE status to approved/rejected at all, so
--     App.Stores.approvePromotion()/rejectPromotion() always failed RLS.
-- ============================================================
drop policy if exists "store_promotions manager write" on public.store_promotions;
create policy "store_promotions manager write" on public.store_promotions
  for all
  using (store_promotions.store_id = public.current_store_id())
  with check (store_promotions.store_id = public.current_store_id());

drop policy if exists "store_promotions developer approve" on public.store_promotions;
create policy "store_promotions developer approve" on public.store_promotions
  for update
  using (public.current_role() = 'developer')
  with check (public.current_role() = 'developer');

-- ============================================================
-- 6b. Avatar uploads: avatars/{userId}/… is owned by that user, not a
--     shop — separate policies from the shop-scoped ones above since
--     images meta/insert own shop can never match a path with no store.
-- ============================================================
drop policy if exists "avatars select authenticated" on storage.objects;
create policy "avatars select authenticated" on storage.objects
  for select to authenticated using (
    bucket_id = 'images' and (storage.foldername(name))[1] = 'avatars'
  );

drop policy if exists "avatars insert own" on storage.objects;
create policy "avatars insert own" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'images' and (storage.foldername(name))[1] = 'avatars'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

drop policy if exists "avatars update own" on storage.objects;
create policy "avatars update own" on storage.objects
  for update to authenticated using (
    bucket_id = 'images' and (storage.foldername(name))[1] = 'avatars'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

drop policy if exists "avatars delete own" on storage.objects;
create policy "avatars delete own" on storage.objects
  for delete to authenticated using (
    bucket_id = 'images' and (storage.foldername(name))[1] = 'avatars'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

-- ============================================================
-- 6d. New role: 'dispatcher' — a delivery coordinator with platform-wide
--     visibility over orders/drivers/reviews and the ability to assign
--     any driver to any order, distinct from an individual 'driver'
--     account (which only ever sees/accepts its own deliveries) and from
--     'developer' (platform admin, unrelated concern). Never self-service
--     — same as kitchen/driver, handle_new_user() already defaults any
--     unrecognized requested role to 'customer', so a dispatcher account
--     can only ever be created by hand in Supabase (Authentication > Add
--     User, then set profiles.role = 'dispatcher' in Table Editor).
-- ============================================================
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('customer','manager','kitchen','cashier','driver','developer','dispatcher'));

drop policy if exists "orders select" on public.orders;
create policy "orders select" on public.orders
  for select using (
    customer_id = auth.uid()
    or public.current_role() in ('driver','dispatcher')
    or (public.current_role() in ('manager','kitchen') and store_id = public.current_store_id())
  );

drop policy if exists "orders staff update" on public.orders;
create policy "orders staff update" on public.orders
  for update
  using (
    public.current_role() in ('driver','dispatcher')
    or (public.current_role() in ('manager','kitchen') and store_id = public.current_store_id())
  );

drop policy if exists "reviews select" on public.reviews;
create policy "reviews select" on public.reviews
  for select using (
    customer_id = auth.uid()
    or public.current_role() in ('driver','dispatcher')
    or (
      public.current_role() in ('manager','kitchen','cashier')
      and exists (
        select 1 from public.orders o
        where o.id = reviews.order_id and o.store_id = public.current_store_id()
      )
    )
  );

-- protect_order_updates() locks down every column except a self-cancel
-- for any caller whose role isn't in this list — dispatcher needs to be
-- able to actually set assigned_driver/eta when assigning a delivery.
create or replace function public.protect_order_updates()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_role() not in ('manager','kitchen','cashier','driver','dispatcher') then
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

-- ============================================================
-- 7a. Fix trg_prevent_role_change so it stops blocking Supabase's own
--     SQL/Table Editor from promoting an account's role. It previously
--     had no bypass at all (unlike enforce_store_status, which does),
--     so every attempt to set role='developer' via Table Editor was
--     silently reverted back to whatever it was before, with no error —
--     the exact reason "promote this account to developer in Table
--     Editor" never actually worked. Direct SQL (auth.uid() is null)
--     is now trusted the same way it already is elsewhere; regular API
--     calls from a logged-in user are still fully blocked from
--     self-changing their own role or store_id.
-- ============================================================
create or replace function public.prevent_role_change()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.role is distinct from old.role then
    new.role := old.role;
  end if;
  if old.store_id is not null and new.store_id is distinct from old.store_id then
    new.store_id := old.store_id;
  end if;
  return new;
end;
$$;

-- ============================================================
-- 8. Driver self-registration with developer approval. Driver accounts
--    now CAN self-register (unlike kitchen/dispatcher/developer, which
--    stay manual-only), but a self-registered driver starts 'pending'
--    and cannot see/accept any real orders until a developer approves
--    them — role='driver' alone is no longer enough for order access.
-- ============================================================
alter table public.profiles add column if not exists status text not null default 'approved'
  check (status in ('pending','approved','rejected'));
alter table public.profiles add column if not exists rejection_reason text;

create or replace function public.current_status()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select status from public.profiles where id = auth.uid();
$$;

-- A developer can review/approve any profile's status (self-update stays
-- limited to id = auth.uid() via the existing "profiles update own" policy
-- — this is additive, not a replacement).
drop policy if exists "profiles developer review" on public.profiles;
create policy "profiles developer review" on public.profiles
  for update
  using (public.current_role() = 'developer')
  with check (public.current_role() = 'developer');

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_id uuid;
  v_requested_role text;
  v_role text;
  v_status text;
begin
  v_requested_role := coalesce(new.raw_user_meta_data->>'role', 'customer');
  v_status := 'approved';

  if v_requested_role = 'developer' then
    if exists (select 1 from public.profiles where role = 'developer') then
      v_role := 'customer';
    else
      v_role := 'developer';
    end if;
  elsif v_requested_role = 'manager' then
    v_role := 'manager';
  elsif v_requested_role = 'driver' then
    -- Self-service, but held to 'pending' until a developer approves it —
    -- see section 8 above for why role alone isn't enough for a driver.
    v_role := 'driver';
    v_status := 'pending';
  else
    v_role := 'customer';
  end if;

  if new.raw_user_meta_data->>'store_name' is not null then
    select id into v_store_id from public.stores where name = new.raw_user_meta_data->>'store_name';
  end if;

  insert into public.profiles (id, name, email, role, phone, store_id, university, status)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
    new.email,
    v_role,
    new.raw_user_meta_data->>'phone',
    v_store_id,
    new.raw_user_meta_data->>'university',
    v_status
  )
  on conflict (id) do nothing;

  if v_store_id is not null and v_role = 'manager' then
    update public.stores set manager_id = new.id where id = v_store_id and manager_id is null;
  end if;

  return new;
end;
$$;

-- A pending/rejected driver has role='driver' but must not actually see or
-- touch real orders/reviews yet — the driver clause in each policy below
-- now also requires current_status() = 'approved'.
drop policy if exists "orders select" on public.orders;
create policy "orders select" on public.orders
  for select using (
    customer_id = auth.uid()
    or (public.current_role() = 'driver' and public.current_status() = 'approved')
    or public.current_role() = 'dispatcher'
    or (public.current_role() in ('manager','kitchen') and store_id = public.current_store_id())
  );

drop policy if exists "orders staff update" on public.orders;
create policy "orders staff update" on public.orders
  for update
  using (
    (public.current_role() = 'driver' and public.current_status() = 'approved')
    or public.current_role() = 'dispatcher'
    or (public.current_role() in ('manager','kitchen') and store_id = public.current_store_id())
  );

drop policy if exists "reviews select" on public.reviews;
create policy "reviews select" on public.reviews
  for select using (
    customer_id = auth.uid()
    or (public.current_role() = 'driver' and public.current_status() = 'approved')
    or public.current_role() = 'dispatcher'
    or (
      public.current_role() in ('manager','kitchen','cashier')
      and exists (
        select 1 from public.orders o
        where o.id = reviews.order_id and o.store_id = public.current_store_id()
      )
    )
  );

-- ============================================================
-- 7. DESTRUCTIVE — demo/seed data cleanup. Run this section only when
--    you're ready to wipe every current store and demo account and
--    start with real businesses you register yourself. This cannot be
--    undone. Comment out or skip this section to keep existing data.
-- ============================================================
-- delete from public.orders;
-- delete from public.notifications;
-- delete from public.reviews;
-- delete from public.store_promotions;
-- delete from public.menu_items;
-- delete from public.stores;
-- delete from auth.users where email like '%@demo.com';

-- ============================================================
-- 8. Shop add-ons: drinks, snacks, sides, desserts and other small
--    items offered as optional checkout upsells. Scoped per store,
--    same manager-owns-own-shop pattern as menu_items.
-- ============================================================
create table if not exists public.menu_addons (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,
  category text not null check (category in ('Drinks','Snacks','Sides','Desserts','Other')),
  price numeric(10,2) not null check (price >= 0),
  image_url text,
  is_available boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_menu_addons_store on public.menu_addons(store_id);

alter table public.menu_addons enable row level security;

drop policy if exists "addons select all" on public.menu_addons;
create policy "addons select all" on public.menu_addons
  for select using (true);

drop policy if exists "addons manager write" on public.menu_addons;
create policy "addons manager write" on public.menu_addons
  for all
  using (public.current_role() = 'manager' and store_id = public.current_store_id())
  with check (public.current_role() = 'manager' and store_id = public.current_store_id());

create or replace function public.touch_menu_addon_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_menu_addons_updated_at on public.menu_addons;
create trigger trg_menu_addons_updated_at
  before update on public.menu_addons
  for each row execute procedure public.touch_menu_addon_updated_at();

-- Let add-on images use the same shop-scoped images metadata table +
-- storage policies as menu item/logo/cover/promotion images.
alter table public.images drop constraint if exists images_kind_check;
alter table public.images add constraint images_kind_check
  check (kind in ('logo','cover','menu_item','promotion','addon'));

-- ============================================================
-- 9. Real OS-level push notifications: one row per subscribed device
--    (browser Push API subscription), so a student can be signed in on
--    several devices and every one of them gets the same push. Sending
--    happens from a Supabase Edge Function (see supabase/functions/send-push)
--    using the VAPID keypair — the private key never reaches the client.
-- ============================================================
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists idx_push_subscriptions_user on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;

-- A device registers/updates/removes only its own subscription row; the
-- Edge Function reads across all users with the service-role key, which
-- bypasses RLS entirely, so no separate "service can read" policy is needed.
drop policy if exists "push subs own" on public.push_subscriptions;
create policy "push subs own" on public.push_subscriptions
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ============================================================
-- 10. Developer platform overview: shop billing + read access to all
--     orders (platform-wide stats). The developer already has an
--     unrestricted UPDATE policy on stores ("stores update developer"),
--     so no new policy is needed just to let them edit monthly_fee.
-- ============================================================
alter table public.stores add column if not exists monthly_fee numeric(10,2) not null default 500 check (monthly_fee >= 0);

-- Developer is the platform admin — needs to read every order across every
-- shop for platform-wide stats, not just their own (they have none).
drop policy if exists "orders select" on public.orders;
create policy "orders select" on public.orders
  for select using (
    customer_id = auth.uid()
    or (public.current_role() = 'driver' and public.current_status() = 'approved')
    or public.current_role() = 'dispatcher'
    or public.current_role() = 'developer'
    or (public.current_role() in ('manager','kitchen') and store_id = public.current_store_id())
  );

create table if not exists public.shop_billing (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.stores(id) on delete cascade,
  billing_period date not null, -- first day of the covered month, e.g. 2026-09-01
  monthly_fee numeric(10,2) not null,
  amount_paid numeric(10,2) not null default 0,
  status text not null default 'pending' check (status in ('paid','unpaid','overdue','pending','waived')),
  payment_date date,
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, billing_period)
);
create index if not exists idx_shop_billing_shop on public.shop_billing(shop_id);
create index if not exists idx_shop_billing_period on public.shop_billing(billing_period);

alter table public.shop_billing enable row level security;

-- Billing is platform-admin-only — no manager visibility was requested,
-- so this table is developer-only end to end, not just hidden in the UI.
drop policy if exists "shop billing developer only" on public.shop_billing;
create policy "shop billing developer only" on public.shop_billing
  for all
  using (public.current_role() = 'developer')
  with check (public.current_role() = 'developer');

create or replace function public.touch_shop_billing_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_shop_billing_updated_at on public.shop_billing;
create trigger trg_shop_billing_updated_at
  before update on public.shop_billing
  for each row execute procedure public.touch_shop_billing_updated_at();

-- ============================================================
-- 11. FIX: shop rating never updated. Root cause was that nothing —
--     client or server — ever wrote to stores.rating/rating_count after
--     the initial seed. The only existing rollup trigger
--     (apply_review_rating, schema.sql) only ever touched menu_items.
--     This section adds the missing per-store rollup, a shop_id column
--     on reviews (derived server-side from the order, never trusted from
--     the client), a one-rating-per-order constraint with proper edit
--     support, tightened RLS (order ownership + delivered-only), and a
--     guard stopping any role but developer from writing rating/
--     rating_count on stores directly.
--
-- DRIFT FOUND AND FIXED (this session): this entire section had NEVER
-- actually been applied — confirmed directly (no store_id/updated_at
-- columns on reviews, no unique constraint on order_id, none of the
-- four functions, zero triggers on reviews at all). Surfaced by a real
-- user-facing error submitting a review ("Could not find the
-- 'updated_at' column of 'reviews' in the schema cache"), since the
-- client has always sent updated_at expecting this section to exist.
-- Reapplied in full. This is the fourth section in this file found to
-- have this exact drift (see also sections 12, 14, and 31) — see the
-- migration-governance-drift memory note: treat this file as intent,
-- not confirmed reality.
--
-- Also (same session, not part of the original section 11): delivery_
-- rating dropped its NOT NULL/1-5-required constraint and is now
-- nullable — this app is pickup/collection-only (Phase 1), so there is
-- no delivery experience for a customer to rate. The column stays for
-- a future delivery phase to reuse; new reviews just never populate it.
-- ============================================================
alter table public.reviews add column if not exists store_id uuid references public.stores(id) on delete cascade;
alter table public.reviews add column if not exists updated_at timestamptz not null default now();
alter table public.stores add column if not exists rating_breakdown jsonb not null default '{}'::jsonb;

-- Backfill store_id on any reviews that already exist, via the order they
-- belong to (reviews has never carried its own shop_id until now).
update public.reviews r set store_id = o.store_id
from public.orders o
where r.order_id = o.id and r.store_id is null;

-- One rating per order. If this fails on real data, some order already has
-- more than one review row — find them with:
--   select order_id, count(*) from public.reviews group by order_id having count(*) > 1;
-- and decide per-row which to keep before re-running this line.
alter table public.reviews drop constraint if exists reviews_order_id_key;
alter table public.reviews add constraint reviews_order_id_key unique (order_id);

-- Derives store_id from the order server-side on insert — the client never
-- supplies it, so it can never be spoofed to point at the wrong shop.
create or replace function public.set_review_store_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select store_id into new.store_id from public.orders where id = new.order_id;
  return new;
end;
$$;

drop trigger if exists trg_set_review_store_id on public.reviews;
create trigger trg_set_review_store_id
  before insert on public.reviews
  for each row execute procedure public.set_review_store_id();

-- Recalculates (never increments) a store's rating/count from every review
-- currently on file for it — the correct, race-condition-safe approach:
-- always derive from the full committed set, never "old average + new
-- rating" arithmetic, which two concurrent submissions could corrupt.
create or replace function public.recalc_store_rating(p_store_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_avg numeric;
  v_count int;
  v_breakdown jsonb;
begin
  if p_store_id is null then return; end if;
  select round(coalesce(avg(overall_rating), 0)::numeric, 1), count(*)
    into v_avg, v_count
    from public.reviews
    where store_id = p_store_id;
  -- Per-star counts as a public aggregate on stores, same as rating/
  -- rating_count — NOT read from the reviews table client-side, since
  -- reviews RLS correctly keeps individual rows private to the reviewer
  -- and that shop's staff; this is how the breakdown UI stays accurate
  -- for any visitor without loosening that.
  select coalesce(jsonb_object_agg(overall_rating, star_count), '{}'::jsonb)
    into v_breakdown
    from (
      select overall_rating, count(*) as star_count
      from public.reviews
      where store_id = p_store_id
      group by overall_rating
    ) t;
  -- Signals the guard trigger below that this write is the legitimate
  -- system rollup, not a direct client update — reset automatically at
  -- the end of the current transaction.
  perform set_config('campus_eats.allow_rating_write', 'on', true);
  update public.stores set rating = v_avg, rating_count = v_count, rating_breakdown = v_breakdown where id = p_store_id;
end;
$$;

create or replace function public.apply_review_to_shop_rating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.recalc_store_rating(old.store_id);
    return old;
  end if;
  perform public.recalc_store_rating(new.store_id);
  if tg_op = 'UPDATE' and old.store_id is distinct from new.store_id then
    perform public.recalc_store_rating(old.store_id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_apply_review_to_shop_rating on public.reviews;
create trigger trg_apply_review_to_shop_rating
  after insert or update or delete on public.reviews
  for each row execute procedure public.apply_review_to_shop_rating();

-- Blocks any direct client write to stores.rating/rating_count (a manager
-- editing their own store, or anyone crafting a raw request) unless it's
-- either the developer role or the system rollup above signalling itself
-- via the transaction-local flag.
create or replace function public.protect_stores_rating_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(current_setting('campus_eats.allow_rating_write', true), 'off') <> 'on'
     and public.current_role() is distinct from 'developer' then
    new.rating := old.rating;
    new.rating_count := old.rating_count;
    new.rating_breakdown := old.rating_breakdown;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_stores_rating on public.stores;
create trigger trg_protect_stores_rating
  before update on public.stores
  for each row execute procedure public.protect_stores_rating_columns();

-- One-time backfill: recompute every store's rating from whatever reviews
-- already exist today, so historical reviews aren't ignored going forward.
do $$
declare r record;
begin
  for r in select id from public.stores loop
    perform public.recalc_store_rating(r.id);
  end loop;
end $$;

-- Tightened reviews RLS: an insert/update must be the reviewer's own,
-- delivered order — not just customer_id matching auth.uid(). Also adds
-- developer read access (previously omitted entirely).
drop policy if exists "reviews select" on public.reviews;
create policy "reviews select" on public.reviews
  for select using (
    customer_id = auth.uid()
    or (public.current_role() = 'driver' and public.current_status() = 'approved')
    or public.current_role() = 'dispatcher'
    or public.current_role() = 'developer'
    or (
      public.current_role() in ('manager', 'kitchen', 'cashier')
      and exists (
        select 1 from public.orders o
        where o.id = reviews.order_id and o.store_id = public.current_store_id()
      )
    )
  );

drop policy if exists "reviews insert own" on public.reviews;
create policy "reviews insert own" on public.reviews
  for insert with check (
    customer_id = auth.uid()
    and exists (
      select 1 from public.orders o
      where o.id = order_id and o.customer_id = auth.uid() and o.status in ('delivered', 'collected')
    )
  );

drop policy if exists "reviews update own" on public.reviews;
create policy "reviews update own" on public.reviews
  for update using (customer_id = auth.uid())
  with check (
    customer_id = auth.uid()
    and exists (
      select 1 from public.orders o
      where o.id = order_id and o.customer_id = auth.uid() and o.status in ('delivered', 'collected')
    )
  );

-- ============================================================
-- 12. PHASE 1: collection-only pickup flow with secure QR/code
-- confirmation. Delivery stays fully intact in the schema/RLS (a store's
-- accepts_delivery flag, driver/dispatcher roles, out_for_delivery/
-- delivered statuses) for a later phase — this section only ADDS a
-- parallel 'collected' terminal status and the token/code needed to
-- confirm it, it does not remove or alter anything delivery-related.
--
-- DRIFT FOUND AND FIXED (this session): despite being documented here,
-- this entire section had NEVER actually been applied to the live
-- database — confirmed via direct inspection (the orders table had
-- none of the four columns below, orders_status_check didn't allow
-- 'collected', and neither the trigger nor confirm_collection() had
-- ever run against production, even though confirm_collection() itself
-- existed as a function — it would have errored the instant anyone
-- called it, referencing columns that didn't exist). Discovered while
-- investigating a user report that "Confirm Collection" didn't work in
-- the kitchen dashboard — the client-side modal/submit handler were
-- ALSO missing entirely (js/shared-ui.js), a second, independent bug
-- stacked on top of this one. Both fixed and re-verified live end to
-- end (wrong code rejected, correct code confirms and marks paid,
-- cash_tendered/collected_at/collected_by recorded correctly) in the
-- same session this comment was added. This is the third time this
-- session a "documented in this file" change turned out to have never
-- actually been run against production (see also: the missing
-- trg_validate_order_pricing trigger, section 14, and the
-- authenticated/anon execute-grant gaps, section 31) — this file
-- records INTENT accurately but has not reliably reflected reality;
-- treat it as a spec to verify against the live database, not proof
-- something is actually deployed.
-- ============================================================
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('received', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'collected', 'cancelled'));

alter table public.orders add column if not exists collection_token uuid;
alter table public.orders add column if not exists collection_code text;
alter table public.orders add column if not exists collected_at timestamptz;
alter table public.orders add column if not exists collected_by uuid references public.profiles(id);

-- Generated the moment an order becomes ready for collection — never
-- client-supplied, so it can't be predicted or spoofed. The short code is
-- derived from the same token purely as a typeable fallback for when
-- scanning isn't practical; both resolve to the same order in
-- confirm_collection() below.
create or replace function public.generate_collection_code()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'ready' and old.status is distinct from 'ready'
     and coalesce(new.delivery_location->>'fulfilment', '') = 'collection' then
    if new.collection_token is null then
      new.collection_token := gen_random_uuid();
    end if;
    if new.collection_code is null then
      new.collection_code := upper(substr(replace(coalesce(new.collection_token, gen_random_uuid())::text, '-', ''), 1, 6));
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_generate_collection_code on public.orders;
create trigger trg_generate_collection_code
  before update on public.orders
  for each row execute procedure public.generate_collection_code();

-- The ONLY path that can ever move an order to 'collected'. Re-derives
-- every precondition from the database itself rather than trusting the
-- caller — authorisation, ownership, current status, and code/token match
-- are all checked here, not just hidden in the UI.
create or replace function public.confirm_collection(p_order_id uuid, p_code text, p_cash_tendered numeric default null)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_input text;
begin
  if public.current_role() not in ('manager', 'kitchen') then
    raise exception 'Not authorised to confirm collection.';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  if v_order.store_id is distinct from public.current_store_id() then
    raise exception 'This order does not belong to your store.';
  end if;
  if v_order.status = 'collected' then
    raise exception 'Order has already been collected.';
  end if;
  if v_order.status <> 'ready' then
    raise exception 'Order is not ready for collection yet.';
  end if;

  v_input := upper(trim(coalesce(p_code, '')));
  if v_input = '' or v_order.collection_code is null
     or v_input not in (upper(v_order.collection_code), upper(v_order.collection_token::text)) then
    raise exception 'Invalid collection code.';
  end if;

  if p_cash_tendered is not null and p_cash_tendered < 0 then
    raise exception 'Cash received cannot be negative.';
  end if;

  update public.orders
    set status = 'collected',
        status_history = coalesce(v_order.status_history, '[]'::jsonb) || jsonb_build_object('status', 'collected', 'at', now()),
        payment_status = 'paid',
        cash_tendered = coalesce(p_cash_tendered, v_order.cash_tendered),
        collected_at = now(),
        collected_by = auth.uid()
    where id = p_order_id
    returning * into v_order;

  return v_order;
end;
$$;

-- Extend the existing column guard so an unauthorised caller (anyone not
-- manager/kitchen/cashier/driver/dispatcher) can never set or overwrite
-- these new fields directly — only the trigger above (system-generated)
-- and confirm_collection() (its own internal auth check) ever touch them.
create or replace function public.protect_order_updates()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_role() not in ('manager','kitchen','cashier','driver','dispatcher') then
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
    new.collection_token := old.collection_token;
    new.collection_code := old.collection_code;
    new.collected_at := old.collected_at;
    new.collected_by := old.collected_by;
  end if;
  return new;
end;
$$;

-- ============================================================
-- 13. Login rate limiting. Supabase Auth's own signInWithPassword is a
-- direct call to a service we don't own, so per-account lockout after N
-- failed attempts can't be enforced by an RLS policy or a trigger on our
-- own tables — it has to sit in front of that call. This table is written
-- ONLY by the secure-login Edge Function (service role, bypasses RLS);
-- no client, however authenticated, can read or write it directly, since
-- a login attempt happens before anyone is authenticated at all.
-- ============================================================
create table if not exists public.login_attempts (
  email text primary key,
  failed_count int not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.login_attempts enable row level security;

-- ============================================================
-- 33. FIX — failed_count above had no time-based reset for attempts
-- below the lockout threshold: it only reset on a successful login or
-- once an active lockout naturally expired. Unrelated failures spread
-- across days (a typo one week, a forgotten password the next) silently
-- compounded into a lockout that then appeared on what felt like a
-- first attempt — confirmed live against a real account. The
-- requirement is "5 failures within a rolling 10-minute window," so
-- individual failure timestamps are needed, not just a running total.
-- secure-login now keeps this capped to the last 10 minutes on every
-- check; anything older rolls off on its own.
-- ============================================================
alter table public.login_attempts add column if not exists attempt_times jsonb not null default '[]'::jsonb;
-- Deliberately no policies at all — default-deny for every client role.

-- ============================================================
-- 14. Price security on order creation. The "orders insert own" RLS policy
-- only checks customer_id = auth.uid() — it was never responsible for the
-- money, and a client could otherwise bypass the frontend entirely (a raw
-- REST call) and insert an order with a fabricated price (e.g. R45 -> R1).
-- This trigger re-derives every item's unit price from the live
-- menu_items/menu_addons rows for that store (the same tables the frontend
-- already prices from) and recomputes subtotal/discount/total from those
-- corrected prices, so what actually gets charged/recorded can never be
-- lower than what the shop itself has priced the item at right now. It
-- does not change the existing "purchased price is snapshotted on the
-- order" rule — a later menu price change still never rewrites past
-- orders, since this only runs at insert time.
-- ============================================================
create or replace function public.validate_order_pricing()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_items jsonb := '[]'::jsonb;
  v_menu_item public.menu_items;
  v_addon public.menu_addons;
  v_addons_total numeric(10,2);
  v_unit_price numeric(10,2);
  v_qty int;
  v_subtotal numeric(10,2) := 0;
  v_addon_name text;
  v_known_addon_price numeric(10,2);
  v_promo public.promotions;
  v_max_discount numeric(10,2);
begin
  if new.store_id is null then
    raise exception 'Order must belong to a store.';
  end if;
  if jsonb_array_length(coalesce(new.items, '[]'::jsonb)) = 0 then
    raise exception 'Order must contain at least one item.';
  end if;

  for v_item in select * from jsonb_array_elements(new.items)
  loop
    v_qty := greatest(1, coalesce((v_item->>'qty')::int, 1));

    if coalesce((v_item->>'isAddon')::boolean, false) then
      select * into v_addon from public.menu_addons
        where id = (v_item->>'menuItemId')::uuid and store_id = new.store_id;
      if not found or not v_addon.is_available then
        raise exception 'One or more add-ons in this order are no longer available.';
      end if;
      v_unit_price := v_addon.price;
    else
      select * into v_menu_item from public.menu_items
        where id = (v_item->>'menuItemId')::uuid and store_id = new.store_id;
      if not found or not v_menu_item.available then
        raise exception 'One or more items in this order are no longer available.';
      end if;
      if v_menu_item.stock < v_qty then
        raise exception 'Only % left of "%".', v_menu_item.stock, v_menu_item.name;
      end if;

      -- The food-detail modal's add-ons (Extra Cheese/Bacon/Sauce/Chips
      -- Portion) are fixed prices hard-coded in the client
      -- (js/pages/customer.js ADDON_OPTIONS), not their own database rows
      -- — re-priced here from that same fixed list so a tampered
      -- addonsTotal can't slip through either.
      v_addons_total := 0;
      if jsonb_typeof(v_item->'addons') = 'array' then
        for v_addon_name in select jsonb_array_elements_text(v_item->'addons')
        loop
          v_known_addon_price := case v_addon_name
            when 'Extra Cheese' then 5
            when 'Extra Bacon' then 8
            when 'Extra Sauce' then 3
            when 'Extra Chips Portion' then 15
            else null
          end;
          if v_known_addon_price is null then
            raise exception 'Unrecognized add-on: %', v_addon_name;
          end if;
          v_addons_total := v_addons_total + v_known_addon_price;
        end loop;
      end if;

      v_unit_price := v_menu_item.price + v_addons_total;
    end if;

    v_items := v_items || jsonb_build_object(
      'menuItemId', v_item->>'menuItemId',
      'name', v_item->>'name',
      'price', round(v_unit_price, 2),
      'qty', v_qty,
      'image', v_item->'image',
      'addons', coalesce(v_item->'addons', '[]'::jsonb),
      'specialInstructions', coalesce(v_item->>'specialInstructions', ''),
      'isAddon', coalesce((v_item->>'isAddon')::boolean, false)
    );
    v_subtotal := v_subtotal + round(v_unit_price, 2) * v_qty;
  end loop;

  new.items := v_items;
  new.subtotal := round(v_subtotal, 2);
  new.delivery_fee := round(coalesce(new.delivery_fee, 0), 2);

  -- Discount is only ever trusted up to what a real, currently-valid promo
  -- code could actually produce against the corrected subtotal above —
  -- never whatever raw number the client happened to send. A multi-store
  -- checkout (App.Pages.Customer.placeOrder) allocates one combined
  -- discount proportionally by subtotal share before calling createOrder
  -- per store, so each split order's own share is always <= what its own
  -- subtotal could earn from the same promo, and this never clamps it.
  if new.promo_code is not null then
    select * into v_promo from public.promotions where code = new.promo_code;
    if not found or not v_promo.active
       or (v_promo.expires_at is not null and v_promo.expires_at < now())
       or (v_promo.usage_limit is not null and v_promo.used_count >= v_promo.usage_limit) then
      v_max_discount := 0;
      new.promo_code := null;
    elsif v_promo.type = 'percentage' then
      v_max_discount := round(new.subtotal * (v_promo.value / 100), 2);
    else
      v_max_discount := least(v_promo.value, new.subtotal);
    end if;
    new.discount := least(greatest(coalesce(new.discount, 0), 0), v_max_discount);
  else
    new.discount := 0;
  end if;

  new.total := greatest(0, new.subtotal + new.delivery_fee - new.discount);

  return new;
end;
$$;

drop trigger if exists trg_validate_order_pricing on public.orders;
create trigger trg_validate_order_pricing
  before insert on public.orders
  for each row execute procedure public.validate_order_pricing();

-- ============================================================
-- 15. Paystack (TEST mode) online payment.
--
-- Orders created via COD are unaffected by any of this — they still go
-- straight through App.Orders.createOrder() exactly as before.
--
-- For "card" (online) payment, the order rows are NOT created at
-- checkout time. Instead:
--   1. paystack-initialize (Edge Function) re-prices the customer's
--      selection server-side (same authoritative source as
--      validate_order_pricing above: live menu_items/menu_addons, never
--      the browser's numbers) and writes ONE checkout_sessions row
--      holding the full per-store breakdown + the combined amount it
--      told Paystack to charge, then calls Paystack's own
--      /transaction/initialize with the secret key and returns only the
--      public authorization_url + reference to the browser.
--   2. The browser redirects to that Paystack-hosted URL — no card
--      details ever pass through our own frontend or backend.
--   3. On return, paystack-verify (Edge Function) calls Paystack's
--      /transaction/verify with the secret key, confirms status=success
--      AND that the verified amount matches what checkout_sessions
--      recorded, then calls finalize_paystack_checkout() below to
--      actually create the real order rows (one per store, same
--      one-store-per-order invariant as COD/multi-shop checkout
--      already uses) — which still passes through
--      trg_validate_order_pricing above as a second, independent check.
--   4. paystack-webhook (Edge Function) calls the same finalize
--      function when Paystack's own charge.success event arrives, so a
--      customer who closes the tab right after paying (never returning
--      to step 3) still gets their order created.
-- finalize_paystack_checkout() is idempotent (row-locked, checked
-- against its own status) so steps 3 and 4 racing/repeating each other,
-- or a customer refreshing the return page, can never double-create
-- orders or double-consume one payment.
-- ============================================================

alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status in ('pending', 'paid', 'failed'));

alter table public.orders add column if not exists payment_reference text;
create index if not exists idx_orders_payment_reference on public.orders(payment_reference) where payment_reference is not null;

-- One row per checkout attempt (not per store — a multi-shop checkout is
-- still a single Paystack charge). RLS is deliberately zero-policy,
-- exactly like login_attempts: a customer never reads/writes this table
-- directly, only the three paystack-* Edge Functions (service role) do.
create table if not exists public.checkout_sessions (
  reference text primary key,
  customer_id uuid not null references public.profiles(id),
  email text not null,
  currency text not null default 'ZAR',
  amount numeric(10,2) not null,
  groups jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  order_ids jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_checkout_sessions_customer on public.checkout_sessions(customer_id);

alter table public.checkout_sessions enable row level security;
-- Deliberately no policies at all — default-deny for every client role.

-- The ONLY path that ever turns a checkout_session into real order rows.
-- Row-locks the session first so a webhook and a browser-return verify
-- racing each other (or either one firing twice) can only ever create
-- the orders once — the second caller just gets back the same order_ids
-- from the now status='paid' row instead of inserting again.
--
-- This does NOT itself talk to Paystack or decide whether a payment is
-- real — the caller (paystack-verify / paystack-webhook) must already
-- have confirmed success with Paystack's API using the secret key before
-- calling this. That's why EXECUTE is revoked from anon/authenticated
-- below: an ordinary logged-in customer must never be able to call this
-- directly and mint themselves a paid order.
create or replace function public.finalize_paystack_checkout(p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.checkout_sessions;
  v_group jsonb;
  v_order public.orders;
  v_order_ids jsonb := '[]'::jsonb;
begin
  select * into v_session from public.checkout_sessions where reference = p_reference for update;
  if not found then
    raise exception 'Unknown checkout session.';
  end if;

  if v_session.status = 'paid' then
    return jsonb_build_object('order_ids', v_session.order_ids);
  end if;

  for v_group in select * from jsonb_array_elements(v_session.groups)
  loop
    insert into public.orders (
      customer_id, store_id, items, subtotal, delivery_fee, discount, promo_code, total,
      payment_method, payment_status, payment_reference, delivery_location, status, status_history
    ) values (
      v_session.customer_id,
      (v_group->>'storeId')::uuid,
      v_group->'items',
      (v_group->>'subtotal')::numeric,
      0,
      coalesce((v_group->>'discount')::numeric, 0),
      v_group->>'promoCode',
      (v_group->>'total')::numeric,
      'card',
      'paid',
      p_reference,
      v_group->'deliveryLocation',
      'received',
      jsonb_build_array(jsonb_build_object('status', 'received', 'at', now()))
    )
    returning * into v_order;

    v_order_ids := v_order_ids || to_jsonb(v_order.id);
  end loop;

  update public.checkout_sessions
    set status = 'paid', order_ids = v_order_ids, updated_at = now()
    where reference = p_reference;

  return jsonb_build_object('order_ids', v_order_ids);
end;
$$;

revoke all on function public.finalize_paystack_checkout(text) from public;
grant execute on function public.finalize_paystack_checkout(text) to service_role;

-- Simple status flip for a payment Paystack itself reports as failed/
-- abandoned — no orders exist yet at this point, so there's nothing to
-- undo, just the session record for support/debugging traceability.
create or replace function public.mark_paystack_checkout_failed(p_reference text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.checkout_sessions
    set status = 'failed', updated_at = now()
    where reference = p_reference and status = 'pending';
end;
$$;

revoke all on function public.mark_paystack_checkout_failed(text) from public;
grant execute on function public.mark_paystack_checkout_failed(text) to service_role;

-- ============================================================
-- 16. Shop payout onboarding + Paystack multi-split.
--
-- Architecture: clickFud keeps ONE Paystack (TEST) account. Each shop
-- gets a Paystack SUBACCOUNT under it (created via paystack-manage-
-- subaccount, service role only) — no shop ever needs its own separate
-- Paystack merchant account. A multi-shop checkout still charges the
-- customer once; paystack-initialize creates a Paystack Transaction
-- Split across every involved shop's subaccount before starting the
-- transaction, so Paystack itself routes each shop's share to its own
-- bank account on settlement — this is not simulated in our database.
--
-- Commission: no per-order commission model existed before this
-- (stores.monthly_fee/shop_billing is a flat monthly platform fee,
-- unrelated). Rather than invent a percentage, platform_config below
-- defaults to 0% (each shop's subaccount gets 100% of its own order
-- total) and stores.commission_percent lets a specific shop be
-- overridden later — both are developer-only to change, never
-- manager-editable, enforced by trigger below (RLS alone can't restrict
-- individual columns on the existing manager-owned-row stores policy).
-- ============================================================

create table if not exists public.platform_config (
  id int primary key default 1 check (id = 1),
  commission_percent numeric(5,2) not null default 0 check (commission_percent >= 0 and commission_percent <= 100),
  updated_at timestamptz not null default now()
);
insert into public.platform_config (id) values (1) on conflict (id) do nothing;

alter table public.platform_config enable row level security;
drop policy if exists "platform_config select staff" on public.platform_config;
create policy "platform_config select staff" on public.platform_config
  for select using (public.current_role() in ('manager', 'developer'));
-- No insert/update/delete policy — changed only via the developer
-- dashboard's service-role path, same as every other developer-only
-- write in this project.

alter table public.stores add column if not exists commission_percent numeric(5,2) check (commission_percent >= 0 and commission_percent <= 100);

create or replace function public.protect_store_commission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.commission_percent is distinct from old.commission_percent and public.current_role() is distinct from 'developer' then
    new.commission_percent := old.commission_percent;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_store_commission on public.stores;
create trigger trg_protect_store_commission
  before update on public.stores
  for each row execute procedure public.protect_store_commission();

-- One row per shop. Writes only ever happen via the paystack-manage-
-- subaccount Edge Function (service role) — a manager can SEE their own
-- shop's row (to render the Payout Setup card) but never write it
-- directly, so a raw PATCH can't self-declare status='active' without
-- Paystack actually having accepted the subaccount. The full bank
-- account number is never stored here, only enough to render a masked
-- "****1234" — Paystack itself holds the authoritative full details.
create table if not exists public.store_payout_accounts (
  store_id uuid primary key references public.stores(id) on delete cascade,
  paystack_subaccount_code text unique,
  paystack_subaccount_id bigint,
  business_name text,
  bank_code text,
  bank_name text,
  account_number_last4 text,
  account_name text,
  currency text not null default 'ZAR',
  country text not null default 'South Africa',
  status text not null default 'not_configured' check (status in ('not_configured', 'pending', 'active', 'failed', 'disabled')),
  last_error text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.store_payout_accounts enable row level security;

drop policy if exists "payout accounts select own or developer" on public.store_payout_accounts;
create policy "payout accounts select own or developer" on public.store_payout_accounts
  for select using (
    (public.current_role() = 'manager' and store_id = public.current_store_id())
    or public.current_role() = 'developer'
  );
-- No insert/update/delete policy — service role (Edge Function) only.

create or replace function public.touch_store_payout_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_store_payout_updated_at on public.store_payout_accounts;
create trigger trg_store_payout_updated_at
  before update on public.store_payout_accounts
  for each row execute procedure public.touch_store_payout_updated_at();

-- Traceability columns on the order itself: what this specific order's
-- shop actually nets and what the platform held back, and which
-- Paystack subaccount the split sent it to — set once, at creation,
-- from the same authoritative split paystack-initialize already
-- computed (never recomputed from anything client-supplied).
alter table public.orders add column if not exists paystack_subaccount_code text;
alter table public.orders add column if not exists payout_amount numeric(10,2);
alter table public.orders add column if not exists platform_fee_amount numeric(10,2);

-- v2: same idempotent create-orders-from-a-paid-session behaviour as
-- before, extended to also persist each order's payout split fields.
create or replace function public.finalize_paystack_checkout(p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.checkout_sessions;
  v_group jsonb;
  v_order public.orders;
  v_order_ids jsonb := '[]'::jsonb;
begin
  select * into v_session from public.checkout_sessions where reference = p_reference for update;
  if not found then
    raise exception 'Unknown checkout session.';
  end if;

  if v_session.status = 'paid' then
    return jsonb_build_object('order_ids', v_session.order_ids);
  end if;

  for v_group in select * from jsonb_array_elements(v_session.groups)
  loop
    insert into public.orders (
      customer_id, store_id, items, subtotal, delivery_fee, discount, promo_code, total,
      payment_method, payment_status, payment_reference, delivery_location, status, status_history,
      paystack_subaccount_code, payout_amount, platform_fee_amount
    ) values (
      v_session.customer_id,
      (v_group->>'storeId')::uuid,
      v_group->'items',
      (v_group->>'subtotal')::numeric,
      0,
      coalesce((v_group->>'discount')::numeric, 0),
      v_group->>'promoCode',
      (v_group->>'total')::numeric,
      'card',
      'paid',
      p_reference,
      v_group->'deliveryLocation',
      'received',
      jsonb_build_array(jsonb_build_object('status', 'received', 'at', now())),
      v_group->>'subaccountCode',
      (v_group->>'shopAmount')::numeric,
      coalesce((v_group->>'platformFeeAmount')::numeric, 0)
    )
    returning * into v_order;

    v_order_ids := v_order_ids || to_jsonb(v_order.id);
  end loop;

  update public.checkout_sessions
    set status = 'paid', order_ids = v_order_ids, updated_at = now()
    where reference = p_reference;

  return jsonb_build_object('order_ids', v_order_ids);
end;
$$;

revoke all on function public.finalize_paystack_checkout(text) from public;
grant execute on function public.finalize_paystack_checkout(text) to service_role;

-- ============================================================
-- 17. Order cancellation fee + refund (customer-requested, 20% default).
--
-- COD orders are unaffected — nothing was ever charged, so cancelling
-- one still just flips status to 'cancelled' for free, exactly as
-- before. Only a paid "card" order triggers the fee: the customer is
-- refunded (100% - cancellation_fee_percent) of the order total via a
-- real Paystack refund against the original transaction reference, and
-- the fee amount is recorded (never actually "collected" separately —
-- it's simply the portion NOT refunded). The 20% figure is
-- developer-configurable via platform_config, not hardcoded per-call,
-- consistent with commission_percent above.
--
-- The previous "orders customer cancel" RLS policy let a customer flip
-- status to 'cancelled' directly via a raw PostgREST update — that
-- policy is dropped here. If left in place alongside this new fee
-- system, a customer could bypass the fee/refund entirely by just
-- cancelling the row directly (getting a free cancellation with no
-- refund ever actually processed on Paystack's side). All customer
-- cancellation now goes through paystack-cancel-order (service role),
-- which is the only path that can move a 'received' order to
-- 'cancelled' for a customer.
-- ============================================================

alter table public.platform_config add column if not exists cancellation_fee_percent numeric(5,2) not null default 20 check (cancellation_fee_percent >= 0 and cancellation_fee_percent <= 100);

drop policy if exists "platform_config select staff" on public.platform_config;
create policy "platform_config select staff" on public.platform_config
  for select using (public.current_role() in ('manager', 'developer', 'customer'));

alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status in ('pending', 'paid', 'failed', 'refunded'));

alter table public.orders add column if not exists cancellation_fee_amount numeric(10,2);
alter table public.orders add column if not exists refund_amount numeric(10,2);
alter table public.orders add column if not exists refunded_at timestamptz;
alter table public.orders add column if not exists paystack_refund_reference text;

drop policy if exists "orders customer cancel" on public.orders;

-- ============================================================
-- 18. Customer campus selection. Signup already asks which university a
-- customer is at (section 5); this adds which specific campus of that
-- university, matching the campus_location a manager already declares for
-- their own store (schema.sql), so the customer home page can put
-- same-campus shops first (js/pages/home.js sortStores()/popularStores())
-- without hiding shops from any other campus. Scoped to University of
-- Pretoria only for now, per the current rollout (js/config.js).
-- ============================================================
alter table public.profiles add column if not exists campus_location text;

-- ============================================================
-- 32. SECURITY FIX — handle_new_user() had a dead-but-exploitable
-- branch: any raw_user_meta_data.store_name that matched an existing
-- store's name got that store's profiles.store_id auto-assigned AND
-- immediately wrote stores.manager_id = new.id (if the store had no
-- manager yet). The real, legitimate registration flow (Staff app's
-- App.Stores.create(), js/stores.js) never sends store_name at
-- signup — it creates the store with manager_id set to the ALREADY-
-- authenticated caller's own id, then links profile.store_id
-- separately, both scoped to that caller. Grepped all three apps'
-- frontend code end to end: nothing legitimately sends store_name at
-- signup. That made this purely an attack surface — anyone could call
-- supabase.auth.signUp() directly (bypassing the UI, which nothing
-- prevents) with {role:'manager', store_name:'<some existing,
-- not-yet-linked shop>'} and take real control of that shop with zero
-- developer review. Removed entirely; store_id is now always null at
-- signup, exactly like a normal customer/driver account, and only
-- ever gets set afterward through the real, self-scoped flow.
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requested_role text;
  v_role text;
  v_status text;
begin
  v_requested_role := coalesce(new.raw_user_meta_data->>'role', 'customer');
  v_status := 'approved';

  if v_requested_role = 'developer' then
    if exists (select 1 from public.profiles where role = 'developer') then
      v_role := 'customer';
    else
      v_role := 'developer';
    end if;
  elsif v_requested_role = 'manager' then
    v_role := 'manager';
  elsif v_requested_role = 'driver' then
    -- Self-service, but held to 'pending' until a developer approves it —
    -- see section 8 above for why role alone isn't enough for a driver.
    v_role := 'driver';
    v_status := 'pending';
  else
    v_role := 'customer';
  end if;

  insert into public.profiles (id, name, email, role, phone, store_id, university, campus_location, status)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
    new.email,
    v_role,
    new.raw_user_meta_data->>'phone',
    null,
    new.raw_user_meta_data->>'university',
    new.raw_user_meta_data->>'campus_location',
    v_status
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

-- ============================================================
-- 19. Manager-controlled publish gate. A developer approving a store no
-- longer immediately puts it in front of customers — the manager must
-- first add at least 5 menu items and upload a logo + cover image
-- (js/pages/manager.js setupChecklist()/renderPublishBanner()), then
-- explicitly click "Publish Your Store". Also fixes a real pre-existing
-- gap: "stores select all" used `using (true)`, so pending/rejected/
-- archived stores were already visible to every customer via a direct
-- API call regardless of what the frontend chose to render — the RLS
-- itself now enforces status+publish, not just the client-side filter
-- in js/pages/home.js.
-- ============================================================
alter table public.stores add column if not exists is_published boolean not null default false;

drop policy if exists "stores select all" on public.stores;
create policy "stores select all" on public.stores
  for select using (
    (status = 'approved' and is_published = true)
    or manager_id = auth.uid()
    or public.current_role() = 'developer'
  );

-- ============================================================
-- 20. Menu item quality/approval system. A menu item a manager creates or
-- meaningfully edits no longer goes live immediately — it sits at
-- status='pending' until a developer reviews it, exactly mirroring the
-- store approval flow above (enforce_store_status / "stores select all").
--
-- What's real vs. what genuinely needs a human, spelled out here since
-- it drives every check below: this project has no AI vision service
-- (no API key, no Edge Function calling one) and none is added by this
-- migration. Watermark/logo/food-detection/inappropriate-content/text-
-- density checks CANNOT be done here — anything claiming otherwise would
-- be faking it. Only technical, code-computable checks are implemented
-- (file type, file size, pixel dimensions, aspect ratio, and a real
-- blur-variance heuristic computed client-side — see js/upload.js). The
-- rest are stored as 'unknown' and needs_manual_review is always true,
-- which is exactly what routes every image to the developer's own eyes
-- in the review screen rather than auto-approving on a guess.
-- ============================================================
alter table public.menu_items add column if not exists status text not null default 'pending' check (status in ('pending','approved','rejected','suspended'));
alter table public.menu_items add column if not exists submitted_at timestamptz not null default now();
alter table public.menu_items add column if not exists approved_at timestamptz;
alter table public.menu_items add column if not exists approved_by uuid references public.profiles(id);
alter table public.menu_items add column if not exists rejected_at timestamptz;
alter table public.menu_items add column if not exists rejection_reason text;
alter table public.menu_items add column if not exists suspended_at timestamptz;
alter table public.menu_items add column if not exists suspended_by uuid references public.profiles(id);

-- Existing rows (seed data, anything created before this migration) are
-- grandfathered straight to approved so nothing already live vanishes.
update public.menu_items set status = 'approved', approved_at = now() where status = 'pending' and created_at < now();

-- Mirrors enforce_store_status() (schema.sql) exactly: a non-developer
-- can never directly write status or any approval/rejection/suspension
-- field, with the one self-service exception of resubmitting a rejected
-- item (status 'rejected' -> 'pending'). Also the reapproval policy: if
-- a manager changes a field that materially affects what the customer
-- sees on an already-APPROVED item, it drops back to pending. This field
-- list is the one and only place that policy lives — extend or shrink it
-- here without touching any RLS policy.
create or replace function public.enforce_menu_item_status()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if TG_OP = 'INSERT' then
    if public.current_role() is distinct from 'developer' then
      new.status := 'pending';
      new.approved_at := null; new.approved_by := null;
      new.rejected_at := null; new.rejection_reason := null;
      new.suspended_at := null; new.suspended_by := null;
    end if;
    new.submitted_at := now();
  elsif TG_OP = 'UPDATE' then
    if public.current_role() is distinct from 'developer' then
      -- Default: nothing status-related changes unless one of the two
      -- transitions below applies — this is what actually stops a
      -- manager writing status='approved' (or tampering with any
      -- approval/rejection/suspension bookkeeping) directly: every field
      -- here is pinned back to its old value first, then only
      -- overridden by a transition this trigger itself decided on.
      new.status := old.status;
      new.approved_at := old.approved_at; new.approved_by := old.approved_by;
      new.rejected_at := old.rejected_at; new.rejection_reason := old.rejection_reason;
      new.suspended_at := old.suspended_at; new.suspended_by := old.suspended_by;
      new.submitted_at := old.submitted_at;

      if old.status = 'rejected' then
        -- Saving ANY edit to a rejected item IS the resubmission — this
        -- is exactly what "Fix & Resubmit" (manager.js) does: it's just
        -- the normal edit form, saved. The client never sends
        -- status='pending' explicitly (the edit form has no status
        -- field at all), so this can't be conditioned on new.status —
        -- it has to trigger off old.status alone.
        new.status := 'pending';
        new.submitted_at := now();
        new.rejected_at := null; new.rejection_reason := null;
      elsif old.status = 'approved' and (
        new.image is distinct from old.image or
        new.name is distinct from old.name or
        new.description is distinct from old.description or
        new.category is distinct from old.category or
        new.ingredients is distinct from old.ingredients or
        new.allergens is distinct from old.allergens
      ) then
        -- Reapproval policy (configurable right here): image, name,
        -- description, category, ingredients and allergens changes send
        -- an approved item back to review. Deliberately NOT in this list:
        -- price, stock, available, preparation_time, low_stock_threshold
        -- — pure operational changes that don't need a human to re-look
        -- at the listing.
        new.status := 'pending';
        new.submitted_at := now();
        new.approved_at := null; new.approved_by := null;
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_menu_item_status on public.menu_items;
create trigger trg_enforce_menu_item_status
  before insert or update on public.menu_items
  for each row execute procedure public.enforce_menu_item_status();

-- "menu select all" (schema.sql) used `using (true)` — every pending/
-- rejected/suspended item was already visible to every customer via a
-- direct API call, same class of gap the stores policy above just fixed.
drop policy if exists "menu select all" on public.menu_items;
create policy "menu select" on public.menu_items
  for select using (
    status = 'approved'
    or store_id = public.current_store_id()
    or public.current_role() = 'developer'
  );

-- Split from the old single "for all" policy so a manager's row-level
-- access to their own store's items is unchanged, while the trigger
-- above (not RLS) is what actually stops them writing status='approved'
-- — RLS controls which rows, the trigger controls what those columns
-- are allowed to become, exactly like stores/enforce_store_status.
drop policy if exists "menu manager write" on public.menu_items;
create policy "menu manager insert" on public.menu_items
  for insert with check (public.current_role() = 'manager' and store_id = public.current_store_id());
create policy "menu manager update" on public.menu_items
  for update using (public.current_role() = 'manager' and store_id = public.current_store_id())
  with check (public.current_role() = 'manager' and store_id = public.current_store_id());
create policy "menu manager delete" on public.menu_items
  for delete using (public.current_role() = 'manager' and store_id = public.current_store_id());
create policy "menu developer update" on public.menu_items
  for update using (public.current_role() = 'developer')
  with check (public.current_role() = 'developer');

-- Per-image technical check results (js/upload.js computes these client-
-- side at upload time — dimensions, file size, aspect ratio, blur
-- variance — and js/menu.js records one row per uploaded image at
-- create/resubmit time). store_id is denormalized onto this table
-- (rather than joining through menu_items in the RLS policy below) to
-- avoid a cross-table subquery inside a policy, which has caused RLS
-- recursion/failures elsewhere in this schema before (see the "images"
-- table's history) — current_store_id() is the safe, established way.
create table if not exists public.image_quality_checks (
  id uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  image_url text not null,
  width int,
  height int,
  file_size int,
  mime_type text,
  aspect_ratio numeric(6,3),
  checks jsonb not null default '{}',
  needs_manual_review boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_quality_checks_menu_item on public.image_quality_checks(menu_item_id);

alter table public.image_quality_checks enable row level security;

drop policy if exists "quality checks select" on public.image_quality_checks;
create policy "quality checks select" on public.image_quality_checks
  for select using (store_id = public.current_store_id() or public.current_role() = 'developer');

drop policy if exists "quality checks insert" on public.image_quality_checks;
create policy "quality checks insert" on public.image_quality_checks
  for insert with check (store_id = public.current_store_id());

-- Full status-change history per menu item (submitted/resubmitted by a
-- manager, approved/rejected/suspended/reinstated by a developer) — the
-- audit trail the review screen's "History" section reads from. Same
-- denormalized store_id pattern as above, same reasoning.
create table if not exists public.menu_item_reviews (
  id uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  actor_id uuid references public.profiles(id),
  actor_name text,
  action text not null check (action in ('submitted','resubmitted','approved','rejected','suspended','reinstated')),
  previous_status text,
  new_status text,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists idx_menu_reviews_menu_item on public.menu_item_reviews(menu_item_id);

alter table public.menu_item_reviews enable row level security;

drop policy if exists "menu reviews select" on public.menu_item_reviews;
create policy "menu reviews select" on public.menu_item_reviews
  for select using (store_id = public.current_store_id() or public.current_role() = 'developer');

drop policy if exists "menu reviews insert" on public.menu_item_reviews;
create policy "menu reviews insert" on public.menu_item_reviews
  for insert with check (store_id = public.current_store_id() or public.current_role() = 'developer');

-- ============================================================
-- 21. Video promotions. A store's homepage placement can now be a short
-- video instead of a static image (js/upload.js compressVideo(), js/
-- pages/home.js heroSection()). media_type picks which of image_url /
-- video_url the customer app actually renders — a row only ever has one
-- or the other populated, never both used at once.
-- ============================================================
alter table public.store_promotions add column if not exists media_type text not null default 'image' check (media_type in ('image', 'video'));
alter table public.store_promotions add column if not exists video_url text;

-- ============================================================
-- 22. Promotion edit/delete permissions corrected: a manager may create
-- a new promotion (self-published, see section above) and delete their
-- own, but may NOT edit one once it exists — only a developer can edit.
-- A developer can also create a promotion directly for any store, and
-- remove one. This replaces the old "for all" manager policy (which let
-- a manager update their own promotions freely) with separate insert/
-- delete grants, and adds the developer insert/delete grants that were
-- missing (developer update already existed as "store_promotions
-- developer approve").
-- ============================================================
drop policy if exists "store_promotions manager write" on public.store_promotions;

drop policy if exists "store_promotions manager insert" on public.store_promotions;
create policy "store_promotions manager insert" on public.store_promotions
  for insert
  with check (store_promotions.store_id = public.current_store_id());

drop policy if exists "store_promotions manager delete" on public.store_promotions;
create policy "store_promotions manager delete" on public.store_promotions
  for delete
  using (store_promotions.store_id = public.current_store_id());

drop policy if exists "store_promotions developer insert" on public.store_promotions;
create policy "store_promotions developer insert" on public.store_promotions
  for insert
  with check (public.current_role() = 'developer');

drop policy if exists "store_promotions developer delete" on public.store_promotions;
create policy "store_promotions developer delete" on public.store_promotions
  for delete
  using (public.current_role() = 'developer');

-- ============================================================
-- 23. FIX: a developer creating/editing a promotion for a shop that
-- isn't their own (section 22 above) could never actually upload the
-- image/video for it — "images insert own shop" (schema.sql) requires
-- the upload path's shop folder to equal the uploader's OWN
-- current_store_id(), which is null for a developer, so the storage
-- write was rejected outright regardless of the new store_promotions
-- policies. Same issue on the public.images metadata table's write
-- policy. Both now also allow a developer through, for any shop.
-- ============================================================
drop policy if exists "images insert developer" on storage.objects;
create policy "images insert developer" on storage.objects
  for insert
  with check (bucket_id = 'images' and public.current_role() = 'developer');

drop policy if exists "images update developer" on storage.objects;
create policy "images update developer" on storage.objects
  for update
  using (bucket_id = 'images' and public.current_role() = 'developer');

drop policy if exists "images delete developer" on storage.objects;
create policy "images delete developer" on storage.objects
  for delete
  using (bucket_id = 'images' and public.current_role() = 'developer');

drop policy if exists "images meta write own shop" on public.images;
create policy "images meta write own shop" on public.images
  for all
  using (shop_id = public.current_store_id() or public.current_role() = 'developer')
  with check (shop_id = public.current_store_id() or public.current_role() = 'developer');

-- ============================================================
-- 24. Promotional videos ended up in their own "video" storage bucket
-- (created directly in the Supabase dashboard, separate from "images")
-- rather than the images bucket gaining video MIME types — js/upload.js
-- was updated to match (VIDEO_BUCKET constant). Same manager-own-shop /
-- developer-any-shop split as the images bucket policies above.
--
-- IMPORTANT — this alone is not enough for videos to actually display:
-- the "video" bucket was created as private. RLS here only governs
-- authenticated insert/update/delete/select; the plain public URL this
-- app's <video src> tags use (storage/v1/object/public/...) is served
-- with NO RLS check at all, gated purely on the bucket's own public/
-- private flag — which the Supabase Management API refuses to change
-- (PATCH/PUT on /storage/buckets/{id} both 404), so it can only be
-- flipped in the dashboard: Storage -> video bucket -> toggle Public.
-- ============================================================
drop policy if exists "video insert own shop" on storage.objects;
create policy "video insert own shop" on storage.objects
  for insert
  with check (bucket_id = 'video' and (storage.foldername(name))[2] = (public.current_store_id())::text);

drop policy if exists "video insert developer" on storage.objects;
create policy "video insert developer" on storage.objects
  for insert
  with check (bucket_id = 'video' and public.current_role() = 'developer');

drop policy if exists "video update own shop" on storage.objects;
create policy "video update own shop" on storage.objects
  for update
  using (bucket_id = 'video' and (storage.foldername(name))[2] = (public.current_store_id())::text);

drop policy if exists "video update developer" on storage.objects;
create policy "video update developer" on storage.objects
  for update
  using (bucket_id = 'video' and public.current_role() = 'developer');

drop policy if exists "video delete own shop" on storage.objects;
create policy "video delete own shop" on storage.objects
  for delete
  using (bucket_id = 'video' and (storage.foldername(name))[2] = (public.current_store_id())::text);

drop policy if exists "video delete developer" on storage.objects;
create policy "video delete developer" on storage.objects
  for delete
  using (bucket_id = 'video' and public.current_role() = 'developer');

drop policy if exists "video select scoped" on storage.objects;
create policy "video select scoped" on storage.objects
  for select
  using (
    bucket_id = 'video'
    and (
      (storage.foldername(name))[2] = (public.current_store_id())::text
      or public.current_role() = 'developer'
      or exists (select 1 from public.stores s where s.id::text = (storage.foldername(name))[2] and s.status = 'approved')
    )
  );

-- ============================================================
-- 25. Promotion attribution: the customer app's hero banner subtitle
-- falls back to "From {store name}" when a placement has no custom
-- message. That's wrong when clickFud itself (the developer) placed
-- the promotion directly for a shop rather than the shop asking for
-- it — those should read "From clickFud" instead. Tracked with a new
-- created_by_role column, set server-side by a trigger (never trusted
-- from the client payload, same reasoning as enforce_menu_item_status()
-- below: RLS decides which rows a role can touch, a trigger decides
-- what a protected column is allowed to become) so a manager can never
-- forge developer attribution on their own placement. Immutable after
-- creation — editing a placement later doesn't change who originally
-- placed it.
-- ============================================================
alter table public.store_promotions add column if not exists created_by_role text not null default 'manager' check (created_by_role in ('manager', 'developer'));

create or replace function public.enforce_promo_creator()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- Table Editor / direct SQL access has no auth.uid() — leave untouched,
  -- same bypass trg_prevent_role_change needed (see project notes).
  if auth.uid() is null then
    return new;
  end if;
  if TG_OP = 'INSERT' then
    new.created_by_role := case when public.current_role() = 'developer' then 'developer' else 'manager' end;
  elsif TG_OP = 'UPDATE' then
    new.created_by_role := old.created_by_role;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_promo_creator on public.store_promotions;
create trigger trg_enforce_promo_creator
  before insert or update on public.store_promotions
  for each row execute function public.enforce_promo_creator();

-- ============================================================
-- 26. Company-wide placements: the developer's "New Placement" shop
-- dropdown only ever listed real shops, so a promotion clickFud wants to
-- run for itself (not on behalf of any one restaurant) had to be forced
-- onto some arbitrary shop, which then showed that shop's name/logo
-- instead of clickFud's. store_id becomes nullable so a developer can
-- publish a placement with no shop attached at all — the customer app
-- already shows "From clickFud" for any developer-created placement
-- (section 25) regardless of store_id, and a null store_id there just
-- means the card/CTA scrolls to the store list instead of opening a
-- specific store. A manager can never produce a null store_id: their
-- insert policy requires store_id = current_store_id(), which a null
-- value can never satisfy (null = anything is null, not true).
-- ============================================================
alter table public.store_promotions alter column store_id drop not null;

-- ============================================================
-- 27. Promotion management is now developer-only, end to end — a manager
-- can no longer create, edit, delete, or upload media for a promotion,
-- not just via the UI (removed from the Staff app entirely) but via any
-- direct API call. This intentionally reverses the manager-self-publish
-- half of section 22, per an explicit later decision. Storage/table
-- policies are scoped by the "promotions" folder segment / kind
-- specifically so a manager's still-needed upload rights for their own
-- menu-item/logo/cover/addon images are untouched.
-- ============================================================
drop policy if exists "store_promotions manager insert" on public.store_promotions;
drop policy if exists "store_promotions manager delete" on public.store_promotions;

drop policy if exists "images insert own shop" on storage.objects;
create policy "images insert own shop" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'images' and
    (storage.foldername(name))[1] <> 'promotions' and
    (storage.foldername(name))[2] = public.current_store_id()::text
  );

drop policy if exists "images update own shop" on storage.objects;
create policy "images update own shop" on storage.objects
  for update to authenticated using (
    bucket_id = 'images' and
    (storage.foldername(name))[1] <> 'promotions' and
    (storage.foldername(name))[2] = public.current_store_id()::text
  );

drop policy if exists "images delete own shop" on storage.objects;
create policy "images delete own shop" on storage.objects
  for delete to authenticated using (
    bucket_id = 'images' and
    (storage.foldername(name))[1] <> 'promotions' and
    (storage.foldername(name))[2] = public.current_store_id()::text
  );

-- The "video" bucket has only ever held promotion videos — a manager has
-- no legitimate use for it at all anymore.
drop policy if exists "video insert own shop" on storage.objects;
drop policy if exists "video update own shop" on storage.objects;
drop policy if exists "video delete own shop" on storage.objects;

drop policy if exists "images meta write own shop" on public.images;
create policy "images meta write own shop" on public.images
  for all
  using ((shop_id = public.current_store_id() and kind <> 'promotion') or public.current_role() = 'developer')
  with check ((shop_id = public.current_store_id() and kind <> 'promotion') or public.current_role() = 'developer');

-- ============================================================
-- 28. "Top Advert" — a single, dedicated slot for the customer home
-- screen's top banner, deliberately SEPARATE from store_promotions
-- (which already exists for the hero/"Promotions" rows). This table
-- starts empty and MUST stay empty until a developer explicitly
-- publishes something — nothing here is ever auto-populated from
-- store_promotions or any other existing media. A manager has no
-- access at all; only current_role() = 'developer' can write.
-- Customers (and guests) can only ever SELECT a row that is both
-- status = 'published' AND active = true — a draft or unpublished
-- advert is invisible to them even via a direct API call.
-- Storage: reuses the existing images/video buckets (no new bucket
-- needed) under a literal "top-advert" folder — the existing
-- "images/video insert/update/delete developer" policies already
-- allow a developer to write to ANY path in those buckets (no
-- per-shop folder check for the developer role), so no new storage
-- policy is required. The images metadata table's shop_id is set to
-- null for these uploads (there's no real shop), which the existing
-- "images meta write own shop" policy above already allows via its
-- current_role() = 'developer' clause.
-- ============================================================
create table if not exists public.top_adverts (
  id uuid primary key default gen_random_uuid(),
  media_type text not null default 'image' check (media_type in ('image', 'video')),
  media_url text,
  title text,
  promo_text text,
  status text not null default 'draft' check (status in ('draft', 'published', 'unpublished')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  created_by uuid references auth.users(id) on delete set null
);

alter table public.top_adverts enable row level security;

drop policy if exists "top_adverts select" on public.top_adverts;
create policy "top_adverts select" on public.top_adverts
  for select using (
    (status = 'published' and active = true) or public.current_role() = 'developer'
  );

drop policy if exists "top_adverts developer insert" on public.top_adverts;
create policy "top_adverts developer insert" on public.top_adverts
  for insert with check (public.current_role() = 'developer');

drop policy if exists "top_adverts developer update" on public.top_adverts;
create policy "top_adverts developer update" on public.top_adverts
  for update using (public.current_role() = 'developer') with check (public.current_role() = 'developer');

drop policy if exists "top_adverts developer delete" on public.top_adverts;
create policy "top_adverts developer delete" on public.top_adverts
  for delete using (public.current_role() = 'developer');

create or replace function public.touch_top_advert_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_top_advert_updated_at on public.top_adverts;
create trigger trg_top_advert_updated_at
  before update on public.top_adverts
  for each row execute function public.touch_top_advert_updated_at();

-- Top Advert media uploads still record a row in public.images (the
-- same metadata table every other upload uses) so upload history/size
-- stays auditable — that table's kind check constraint needed a new
-- 'top_advert' value added alongside the existing five. This is
-- metadata bookkeeping only; it does not affect RLS (images meta write
-- own shop already allows current_role() = 'developer' through) and
-- does not link top_adverts to store_promotions in any way.
alter table public.images drop constraint if exists images_kind_check;
alter table public.images add constraint images_kind_check
  check (kind in ('logo','cover','menu_item','promotion','addon','top_advert'));

-- ============================================================
-- 29. Product-specific extras/customizations — fixes a real bug where
-- every single menu item (a coffee, a drink, anything) showed the exact
-- same 4 checkboxes ("Extra Cheese", "Extra Bacon", "Extra Sauce",
-- "Extra Chips Portion") regardless of category or product. Those were
-- never database rows at all — a hardcoded array in the customer app
-- (js/pages/customer.js ADDON_OPTIONS, now removed) duplicated by a
-- hardcoded CASE list inside validate_order_pricing() (section 14,
-- now replaced below). There was nothing to "migrate": no per-product
-- extra data existed anywhere to preserve, since the old system was
-- pure hardcoded UI, not real rows.
--
-- This is DELIBERATELY separate from public.menu_addons (section 8),
-- which is a different, already-correct feature — a store-wide
-- checkout-upsell catalog (drinks/snacks/sides shown at checkout,
-- never as modifiers on a specific product). menu_addons is untouched.
--
-- item_extras: the manager's own library of possible per-product
-- customizations for their store (e.g. "Extra Espresso Shot", R5).
-- item_extra_links: which specific menu_items a given extra actually
-- applies to — a real many-to-many relationship, so "Extra Cheese" can
-- apply to a Kota but never to an Expresso, entirely the manager's
-- choice. A menu item with zero linked (available) extras simply has
-- no Add-ons section at all on the customer side.
-- ============================================================
create table if not exists public.item_extras (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,
  description text default '',
  price numeric(10,2) not null check (price >= 0),
  available boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_item_extras_store on public.item_extras(store_id);

alter table public.item_extras enable row level security;

drop policy if exists "item_extras select all" on public.item_extras;
create policy "item_extras select all" on public.item_extras
  for select using (true);

drop policy if exists "item_extras manager write" on public.item_extras;
create policy "item_extras manager write" on public.item_extras
  for all
  using (public.current_role() = 'manager' and store_id = public.current_store_id())
  with check (public.current_role() = 'manager' and store_id = public.current_store_id());

create or replace function public.touch_item_extras_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_item_extras_updated_at on public.item_extras;
create trigger trg_item_extras_updated_at
  before update on public.item_extras
  for each row execute procedure public.touch_item_extras_updated_at();

create table if not exists public.item_extra_links (
  id uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  item_extra_id uuid not null references public.item_extras(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (menu_item_id, item_extra_id)
);
create index if not exists idx_item_extra_links_menu_item on public.item_extra_links(menu_item_id);
create index if not exists idx_item_extra_links_extra on public.item_extra_links(item_extra_id);

alter table public.item_extra_links enable row level security;

drop policy if exists "item_extra_links select all" on public.item_extra_links;
create policy "item_extra_links select all" on public.item_extra_links
  for select using (true);

-- No recursive RLS risk: these subqueries hit menu_items/item_extras,
-- neither of which has a policy that reads item_extra_links back.
drop policy if exists "item_extra_links manager write" on public.item_extra_links;
create policy "item_extra_links manager write" on public.item_extra_links
  for all
  using (
    public.current_role() = 'manager'
    and exists (select 1 from public.menu_items mi where mi.id = menu_item_id and mi.store_id = public.current_store_id())
  )
  with check (
    public.current_role() = 'manager'
    and exists (select 1 from public.menu_items mi where mi.id = menu_item_id and mi.store_id = public.current_store_id())
    and exists (select 1 from public.item_extras ie where ie.id = item_extra_id and ie.store_id = public.current_store_id())
  );

-- Denormalized public read view: every (menu_item, extra) pair that's
-- both linked AND currently available, with the extra's name/price
-- already joined in. The customer app fetches this once per session
-- (public, unauthenticated-readable, mirroring menu_addons' own "select
-- all" policy) and filters client-side by menu_item_id — no per-product
-- round trip, and the browser never needs to join item_extras/
-- item_extra_links itself.
create or replace view public.menu_item_extras_public as
select iel.menu_item_id, ie.id as extra_id, ie.store_id, ie.name, ie.description, ie.price
from public.item_extra_links iel
join public.item_extras ie on ie.id = iel.item_extra_id
where ie.available = true;

grant select on public.menu_item_extras_public to anon, authenticated;

-- Replaces the hardcoded CASE list from section 14 with a real lookup:
-- every extra id the client sends for a non-addon cart line must be
-- linked to THAT exact menu item, belong to the order's own store, and
-- be currently available, or the whole order insert is rejected. The
-- name/price actually stored on the order always come from this live
-- lookup — never from whatever the client sent — so a tampered id that
-- happens to resolve to something real still can't carry a tampered
-- name/price through. isAddon (menu_addons) cart lines are untouched,
-- same live-lookup-by-id behavior they already had.
--
-- IMPORTANT — while rewriting this, discovered trg_validate_order_pricing
-- was NOT actually attached to public.orders (pg_trigger had no row for
-- it at all, despite section 14 above describing it as created) — order
-- price validation had not been enforced for some unknown period before
-- this section. Re-created via the same drop/create at the bottom of
-- this section; verified live via direct test inserts (tampered price
-- rejected/corrected, wrong-product and disabled extras rejected).
create or replace function public.validate_order_pricing()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_items jsonb := '[]'::jsonb;
  v_menu_item public.menu_items;
  v_addon public.menu_addons;
  v_addons_total numeric(10,2);
  v_addons_out jsonb;
  v_addon_obj jsonb;
  v_extra_id uuid;
  v_item_extra public.item_extras;
  v_unit_price numeric(10,2);
  v_qty int;
  v_subtotal numeric(10,2) := 0;
  v_promo public.promotions;
  v_max_discount numeric(10,2);
begin
  if new.store_id is null then
    raise exception 'Order must belong to a store.';
  end if;
  if jsonb_array_length(coalesce(new.items, '[]'::jsonb)) = 0 then
    raise exception 'Order must contain at least one item.';
  end if;

  for v_item in select * from jsonb_array_elements(new.items)
  loop
    v_qty := greatest(1, coalesce((v_item->>'qty')::int, 1));

    if coalesce((v_item->>'isAddon')::boolean, false) then
      select * into v_addon from public.menu_addons
        where id = (v_item->>'menuItemId')::uuid and store_id = new.store_id;
      if not found or not v_addon.is_available then
        raise exception 'One or more add-ons in this order are no longer available.';
      end if;
      v_unit_price := v_addon.price;
      v_addons_out := '[]'::jsonb;
    else
      select * into v_menu_item from public.menu_items
        where id = (v_item->>'menuItemId')::uuid and store_id = new.store_id;
      if not found or not v_menu_item.available then
        raise exception 'One or more items in this order are no longer available.';
      end if;
      if v_menu_item.stock < v_qty then
        raise exception 'Only % left of "%".', v_menu_item.stock, v_menu_item.name;
      end if;

      v_addons_total := 0;
      v_addons_out := '[]'::jsonb;
      if jsonb_typeof(v_item->'addons') = 'array' then
        for v_addon_obj in select * from jsonb_array_elements(v_item->'addons')
        loop
          begin
            v_extra_id := (v_addon_obj->>'id')::uuid;
          exception when others then
            raise exception 'Invalid extra selection.';
          end;
          select ie.* into v_item_extra from public.item_extras ie
            join public.item_extra_links iel on iel.item_extra_id = ie.id
            where ie.id = v_extra_id
              and iel.menu_item_id = v_menu_item.id
              and ie.store_id = new.store_id
              and ie.available = true;
          if not found then
            raise exception 'One or more selected extras are no longer available for "%".', v_menu_item.name;
          end if;
          v_addons_total := v_addons_total + v_item_extra.price;
          v_addons_out := v_addons_out || jsonb_build_object('id', v_item_extra.id, 'name', v_item_extra.name, 'price', v_item_extra.price);
        end loop;
      end if;

      v_unit_price := v_menu_item.price + v_addons_total;
    end if;

    v_items := v_items || jsonb_build_object(
      'menuItemId', v_item->>'menuItemId',
      'name', v_item->>'name',
      'price', round(v_unit_price, 2),
      'qty', v_qty,
      'image', v_item->'image',
      'addons', v_addons_out,
      'specialInstructions', coalesce(v_item->>'specialInstructions', ''),
      'isAddon', coalesce((v_item->>'isAddon')::boolean, false)
    );
    v_subtotal := v_subtotal + round(v_unit_price, 2) * v_qty;
  end loop;

  new.items := v_items;
  new.subtotal := round(v_subtotal, 2);
  new.delivery_fee := round(coalesce(new.delivery_fee, 0), 2);

  if new.promo_code is not null then
    select * into v_promo from public.promotions where code = new.promo_code;
    if not found or not v_promo.active
       or (v_promo.expires_at is not null and v_promo.expires_at < now())
       or (v_promo.usage_limit is not null and v_promo.used_count >= v_promo.usage_limit) then
      v_max_discount := 0;
      new.promo_code := null;
    elsif v_promo.type = 'percentage' then
      v_max_discount := round(new.subtotal * (v_promo.value / 100), 2);
    else
      v_max_discount := least(v_promo.value, new.subtotal);
    end if;
    new.discount := least(greatest(coalesce(new.discount, 0), 0), v_max_discount);
  else
    new.discount := 0;
  end if;

  new.total := greatest(0, new.subtotal + new.delivery_fee - new.discount);

  return new;
end;
$$;

drop trigger if exists trg_validate_order_pricing on public.orders;
create trigger trg_validate_order_pricing
  before insert on public.orders
  for each row execute procedure public.validate_order_pricing();

-- ============================================================
-- 30. Kitchen staff provisioning — 'kitchen' has always been a real,
-- fully-wired profiles.role value (base schema.sql check constraint),
-- with its own independent top-level page module (PAGE_MODULES.kitchen
-- in js/app.js, separate from Manager) and RLS already granting
-- kitchen-role profiles manager-equivalent, store-scoped access to
-- orders (~10+ existing policy clauses use current_role() in
-- ('manager','kitchen')) — but there was NO way for any account to
-- ever actually become role='kitchen': handle_new_user() deliberately
-- downgrades any self-service signup request for it to 'customer'
-- (security-critical, unchanged), and no UI anywhere let a manager
-- create one. This section adds the real provisioning path: a manager
-- creates a kitchen-staff account via the create-kitchen-staff Edge
-- Function (supabase/functions/create-kitchen-staff), which creates
-- the auth user via the Admin API (still lands as 'customer' via the
-- unchanged trigger) then calls provision_kitchen_staff() below to
-- correct the role/store_id past trg_prevent_role_change — the same
-- disable/update/enable-trigger pattern used manually throughout this
-- project's own QA tooling all session, now a real, permanent function.
--
-- `active` is a new generic column (any role, defaults true) folded
-- directly into current_role() — deactivating ANY staff account (a
-- manager sets active=false) makes current_role() return null for
-- that user, which instantly fails every existing RLS policy/function
-- guard that checks current_role() across the whole app, with zero
-- per-policy changes required. This is how "deactivate kitchen staff"
-- (and future roles) is enforced, not a UI-only toggle.
-- ============================================================
alter table public.profiles add column if not exists active boolean not null default true;

create or replace function public.current_role()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select case when active then role else null end from public.profiles where id = auth.uid();
$$;

-- provision_kitchen_staff: only ever callable by the create-kitchen-staff
-- Edge Function's service-role client — see security note in section 31
-- below on why EXECUTE must be revoked from anon/authenticated
-- explicitly, not just "from public".
create or replace function public.provision_kitchen_staff(p_user_id uuid, p_store_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  alter table public.profiles disable trigger trg_prevent_role_change;
  update public.profiles set role = 'kitchen', store_id = p_store_id, name = coalesce(nullif(p_name, ''), name)
    where id = p_user_id;
  alter table public.profiles enable trigger trg_prevent_role_change;
end;
$$;

revoke all on function public.provision_kitchen_staff(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.provision_kitchen_staff(uuid, uuid, text) to service_role;

-- Lets a manager toggle active/name on their OWN store's kitchen staff
-- directly from the client (no Edge Function needed for this part) —
-- safe even though this policy doesn't restrict which columns can be
-- touched, because trg_prevent_role_change (existing) silently reverts
-- any attempted role/store_id change regardless of what this policy
-- allows, exactly the same "RLS controls rows, triggers control
-- columns" split used throughout this project.
drop policy if exists "profiles manager update own kitchen staff" on public.profiles;
create policy "profiles manager update own kitchen staff" on public.profiles
  for update
  using (public.current_role() = 'manager' and role = 'kitchen' and store_id = public.current_store_id())
  with check (public.current_role() = 'manager' and role = 'kitchen' and store_id = public.current_store_id());

-- ============================================================
-- 31. SECURITY FIX — three existing security-definer functions had
-- `revoke all on function ... from public;` without also explicitly
-- revoking from `anon`/`authenticated`. In this Supabase project those
-- two roles turned out to already hold their own EXECUTE grant
-- independent of the PUBLIC pseudo-role (confirmed via
-- has_function_privilege() — revoking from `public` alone left
-- auth_can_call/anon_can_call = true for all three). Discovered while
-- building provision_kitchen_staff() above and immediately audited
-- across every security-definer function in the schema.
--
-- Of those, finalize_paystack_checkout(reference) was a REAL,
-- exploitable vulnerability: it creates real order rows from a
-- checkout_sessions row WITHOUT itself verifying payment with Paystack
-- (that check only happens in the paystack-verify/paystack-webhook
-- Edge Functions, which are supposed to be the only callers). Any
-- authenticated customer could start a normal checkout (getting back a
-- real, valid `reference` for their OWN pending session), never pay,
-- and then call `supabase.rpc('finalize_paystack_checkout', {p_reference})`
-- directly from the browser to create the order anyway — a free-order
-- fraud path, not a theoretical one. mark_paystack_checkout_failed had
-- the same grant gap (lower severity — denial-of-service on one's own
-- pending session at worst, not fraud). confirm_collection has the
-- same broad grant but was NOT vulnerable: it does its own complete
-- authorization internally (current_role() in ('manager','kitchen'),
-- own-store check, and a secret collection code/token check), so an
-- anonymous or wrong-role caller is already rejected regardless of the
-- function-level grant.
--
-- Fix: explicitly revoke from anon AND authenticated (not just
-- public) on both, matching the already-correct pattern now used for
-- provision_kitchen_staff above.
-- ============================================================
revoke all on function public.finalize_paystack_checkout(text) from public, anon, authenticated;
grant execute on function public.finalize_paystack_checkout(text) to service_role;

revoke all on function public.mark_paystack_checkout_failed(text) from public, anon, authenticated;
grant execute on function public.mark_paystack_checkout_failed(text) to service_role;

-- ============================================================
-- 32. Kitchen login business rule — one SHARED kitchen account per
-- shop (not one per employee), with a fixed, standardized email
-- derived from the shop's own name rather than manager-chosen —
-- "<slugified shop name>@kitchen.gmail.com" (e.g. "Kota Hub" ->
-- kotahub@kitchen.gmail.com). Enforced in create-kitchen-staff (the
-- Edge Function refuses a second account for a store that already has
-- one), and backstopped here at the database level with a partial
-- unique index so this can never be violated even by a future
-- application bug — not "rely only on frontend filtering".
--
-- Since the email is fixed and isn't a real inbox, there's no
-- self-service "forgot password" — reset-kitchen-password (Edge
-- Function) lets the shop's manager set a new password for their
-- store's existing kitchen account at any time, keeping the same
-- fixed email.
-- ============================================================
create unique index if not exists idx_profiles_one_kitchen_per_store
  on public.profiles (store_id) where role = 'kitchen';

-- ============================================================
-- 33. Intelligent Inventory System — automatic stock ledger,
-- history, percentage-based low-stock status, and supplier
-- management, built on top of the EXISTING menu_items.stock model
-- (a "Quarters"/"Coca-Cola" menu item already IS the inventory unit
-- in this app — there is no separate raw-ingredient stock system,
-- and this migration does not invent one). Every write path below
-- funnels through a security-definer function so inventory_movements
-- is always an accurate, tamper-proof ledger regardless of which UI
-- action touched stock.
-- ============================================================

-- 33a. New columns on menu_items: target_stock is the "full/original
-- stock" reference point the manager restocks up to — percentage-based
-- LOW STOCK / CRITICAL thresholds are computed against this, not
-- against an arbitrary absolute number. low_stock_percent is the
-- manager-configurable "warn when this % remains" threshold (default
-- 20%, matching the worked example in the spec). supplier_id links an
-- item to the supplier who restocks it. The existing low_stock_threshold
-- column (absolute count) is left completely untouched and still used
-- as a fallback for any item that has no target_stock set yet.
alter table public.menu_items add column if not exists target_stock int;
alter table public.menu_items add column if not exists low_stock_percent int not null default 20 check (low_stock_percent between 1 and 90);
update public.menu_items set target_stock = stock where target_stock is null;

-- 33b. Suppliers — one manager's own contact book, scoped like every
-- other manager-owned table (current_role()/current_store_id(), never
-- a raw subquery against stores/profiles — see the images-policy
-- lesson elsewhere in this file).
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,
  whatsapp text,
  email text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_suppliers_store on public.suppliers(store_id);

alter table public.menu_items add column if not exists supplier_id uuid references public.suppliers(id) on delete set null;

create or replace function public.touch_supplier_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_suppliers_updated_at on public.suppliers;
create trigger trg_suppliers_updated_at
  before update on public.suppliers
  for each row execute procedure public.touch_supplier_updated_at();

alter table public.suppliers enable row level security;

drop policy if exists "suppliers manager write" on public.suppliers;
create policy "suppliers manager write" on public.suppliers
  for all
  using (public.current_role() = 'manager' and store_id = public.current_store_id())
  with check (public.current_role() = 'manager' and store_id = public.current_store_id());

-- 33c. Inventory movements — the actual sales/restock/adjustment
-- ledger the manager's History and Forecast views are built from.
-- Nothing except the security-definer functions below (and the order
-- trigger) is ever granted INSERT/UPDATE/DELETE on this table — a
-- manager can only ever read it, never edit history after the fact.
create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  movement_type text not null check (movement_type in ('sale','restock','adjustment')),
  quantity_change int not null,
  opening_stock int not null,
  closing_stock int not null,
  order_id uuid references public.orders(id) on delete set null,
  note text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_inv_move_store_item_date on public.inventory_movements(store_id, menu_item_id, created_at);
create index if not exists idx_inv_move_order on public.inventory_movements(order_id);

alter table public.inventory_movements enable row level security;

drop policy if exists "inventory_movements select own store" on public.inventory_movements;
create policy "inventory_movements select own store" on public.inventory_movements
  for select using (
    (public.current_role() = 'manager' and store_id = public.current_store_id())
    or public.current_role() = 'developer'
  );

-- 33d. DRIFT FOUND AND FIXED while testing this section end-to-end: the
-- trg_decrement_menu_stock trigger documented in schema.sql did not
-- actually exist on the live orders table (pg_trigger had zero rows for
-- it) — another instance of the same "this file documents intent, not
-- confirmed reality" class of drift already seen elsewhere in this
-- file. Automatic stock decrement was therefore NEVER actually running
-- on real orders before this fix, regardless of what schema.sql says.
-- The create trigger below (idempotent via drop-if-exists) restores it.
--
-- decrement_menu_stock (fires after every order
-- INSERT — this app has no separate "manager accepts the order" step;
-- an order is already live in the kitchen the instant it's placed, so
-- insert-time IS the "order accepted/processed" moment) now also
-- writes one ledger row per line item, instead of only mutating
-- menu_items.stock silently as before.
create or replace function public.decrement_menu_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  v_old_stock int;
  v_new_stock int;
  v_qty int;
begin
  for item in select * from jsonb_array_elements(new.items)
  loop
    v_qty := coalesce((item->>'qty')::int, 0);
    select stock into v_old_stock from public.menu_items where id = (item->>'menuItemId')::uuid;
    if v_old_stock is null then continue; end if;
    v_new_stock := greatest(0, v_old_stock - v_qty);

    update public.menu_items
    set stock = v_new_stock, available = (v_new_stock > 0)
    where id = (item->>'menuItemId')::uuid;

    insert into public.inventory_movements
      (store_id, menu_item_id, movement_type, quantity_change, opening_stock, closing_stock, order_id)
    values
      (new.store_id, (item->>'menuItemId')::uuid, 'sale', -(v_old_stock - v_new_stock), v_old_stock, v_new_stock, new.id);
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_decrement_menu_stock on public.orders;
create trigger trg_decrement_menu_stock
  after insert on public.orders
  for each row execute procedure public.decrement_menu_stock();

-- 33e. Restock — adds a quantity on top of current stock (the manager
-- enters "how much came in", never a raw absolute number, matching the
-- spec's 20 + 100 = 120 worked example). Also raises target_stock if
-- this restock brought the shop above its previous "full" level, so a
-- one-off big delivery correctly becomes the new percentage baseline.
create or replace function public.restock_menu_item(p_item_id uuid, p_qty_added int, p_note text default null)
returns public.menu_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.menu_items;
  v_old_stock int;
  v_new_stock int;
begin
  -- "is distinct from", not <>: current_role() returns NULL for a
  -- deactivated account (see current_role()'s `active` check) or a
  -- missing profile, and NULL <> 'manager' evaluates to NULL — which
  -- PL/pgSQL's `if` treats as false, silently SKIPPING this guard
  -- instead of blocking. `is distinct from` treats NULL as a real,
  -- non-manager value, so the check actually fires.
  if public.current_role() is distinct from 'manager' then
    raise exception 'Only managers can restock inventory.';
  end if;
  if p_qty_added is null or p_qty_added <= 0 then
    raise exception 'Restock quantity must be greater than zero.';
  end if;

  select * into v_item from public.menu_items where id = p_item_id for update;
  if v_item.id is null then raise exception 'Item not found.'; end if;
  if v_item.store_id is distinct from public.current_store_id() then raise exception 'Not authorized for this item.'; end if;

  v_old_stock := v_item.stock;
  v_new_stock := v_old_stock + p_qty_added;

  update public.menu_items
  set stock = v_new_stock, available = true, target_stock = greatest(coalesce(target_stock, 0), v_new_stock)
  where id = p_item_id
  returning * into v_item;

  insert into public.inventory_movements
    (store_id, menu_item_id, movement_type, quantity_change, opening_stock, closing_stock, note, created_by)
  values
    (v_item.store_id, p_item_id, 'restock', p_qty_added, v_old_stock, v_new_stock, p_note, auth.uid());

  return v_item;
end;
$$;

revoke all on function public.restock_menu_item(uuid, int, text) from public, anon;
grant execute on function public.restock_menu_item(uuid, int, text) to authenticated;

-- 33f. Adjustment — a direct correction to an exact stock number (stock
-- take, spoilage, breakage, a miscount) rather than a delta. Kept
-- separate from restock so the ledger's movement_type always tells the
-- manager WHY a number changed, not just that it did.
create or replace function public.adjust_menu_stock(p_item_id uuid, p_new_stock int, p_reason text default null)
returns public.menu_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.menu_items;
  v_old_stock int;
begin
  -- See restock_menu_item above for why this must be "is distinct from",
  -- not <> (NULL current_role() must be treated as "not a manager").
  if public.current_role() is distinct from 'manager' then
    raise exception 'Only managers can adjust inventory.';
  end if;
  if p_new_stock is null or p_new_stock < 0 then
    raise exception 'Stock cannot be negative.';
  end if;

  select * into v_item from public.menu_items where id = p_item_id for update;
  if v_item.id is null then raise exception 'Item not found.'; end if;
  if v_item.store_id is distinct from public.current_store_id() then raise exception 'Not authorized for this item.'; end if;

  v_old_stock := v_item.stock;

  update public.menu_items
  set stock = p_new_stock, available = (p_new_stock > 0)
  where id = p_item_id
  returning * into v_item;

  if p_new_stock <> v_old_stock then
    insert into public.inventory_movements
      (store_id, menu_item_id, movement_type, quantity_change, opening_stock, closing_stock, note, created_by)
    values
      (v_item.store_id, p_item_id, 'adjustment', p_new_stock - v_old_stock, v_old_stock, p_new_stock, p_reason, auth.uid());
  end if;

  return v_item;
end;
$$;

revoke all on function public.adjust_menu_stock(uuid, int, text) from public, anon;
grant execute on function public.adjust_menu_stock(uuid, int, text) to authenticated;

-- ============================================================
-- 34. Supplier communication log — a real, backend-sent restock
-- email (never a mailto: link the manager's own mail client would send
-- from THEIR personal address) needs somewhere to record what was
-- actually sent. Written ONLY by the send-supplier-email Edge Function
-- using the service-role key, after a real send attempt — never by the
-- client directly, so a manager can't fabricate a "Sent" record for an
-- email that was never actually delivered.
-- ============================================================
create table if not exists public.supplier_messages (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  sent_by uuid references public.profiles(id),
  sent_by_email text,
  recipient_email text not null,
  subject text not null,
  body text not null,
  item_ids uuid[] not null default '{}',
  status text not null default 'sent' check (status in ('sent', 'failed')),
  error_message text,
  created_at timestamptz not null default now()
);
create index if not exists idx_supplier_messages_store on public.supplier_messages(store_id, created_at desc);
create index if not exists idx_supplier_messages_supplier on public.supplier_messages(supplier_id);

alter table public.supplier_messages enable row level security;

drop policy if exists "supplier_messages select own store" on public.supplier_messages;
create policy "supplier_messages select own store" on public.supplier_messages
  for select using (
    (public.current_role() = 'manager' and store_id = public.current_store_id())
    or public.current_role() = 'developer'
  );

-- ============================================================
-- 35. Business registration wizard — new fields on the EXISTING
-- stores table only. No new tables: a business application already
-- IS a stores row (status: pending/approved/rejected/archived,
-- rejection_reason, is_registered_business) with an already-working
-- manager-submit / developer-approve workflow (js/pages/manager.js
-- renderOnboarding()/renderApplicationStatus(), js/pages/developer.js
-- renderApplications()). This section only adds the extra fields the
-- MVP registration wizard collects that didn't have a column yet.
-- Delivery deliberately gets no new column at all here — every store
-- already defaults to accepts_delivery = true with zero business-owned
-- driver concept anywhere in this schema, so "delivery is provided by
-- the platform" was already the only model that ever existed; the
-- wizard's Step 5 is purely an acknowledgement screen, nothing to store
-- beyond the single terms_accepted_at timestamp below.
-- ============================================================
alter table public.stores add column if not exists address text;
alter table public.stores add column if not exists business_type text;
alter table public.stores drop constraint if exists stores_business_type_check;
alter table public.stores add constraint stores_business_type_check
  check (business_type is null or business_type in ('restaurant', 'fast_food', 'kota_shop', 'takeaway', 'bakery', 'grocery', 'other'));

alter table public.stores add column if not exists manager_name text;
alter table public.stores add column if not exists manager_email text;
alter table public.stores add column if not exists manager_phone text;
alter table public.stores add column if not exists manager_position text;
alter table public.stores drop constraint if exists stores_manager_position_check;
alter table public.stores add constraint stores_manager_position_check
  check (manager_position is null or manager_position in ('owner', 'manager', 'other'));

-- Distinct from the pre-existing free-text `category` column (which
-- customer-facing category-chip filtering already relies on exact-
-- match, schema.sql / js/pages/home.js) — this is the wizard's own
-- multi-select tag list, purely additive and never read by that
-- filter. New registrations also set `category` itself to the plain
-- label of business_type (done client-side in js/stores.js), which
-- happens to fix a latent bug for future stores: the old onboarding
-- form let a manager type ANY free text into `category` (its
-- placeholder even suggested comma-separated values like "Fast Food,
-- Coffee, Bakery"), which never actually matched the exact-match
-- category-chip filter correctly. Existing stores' `category` values
-- are left untouched — only how NEW registrations populate it changes.
alter table public.stores add column if not exists product_categories text[] not null default '{}';
alter table public.stores add column if not exists products_summary text not null default '';

-- One timestamp covers every checkbox in Step 6 (all six are shown and
-- required client-side before submission is even possible) plus the
-- Step 5 delivery acknowledgement — there is no real product need to
-- track which of six near-identical confirmations was checked
-- individually, only that the manager passed through that screen and
-- affirmatively submitted.
alter table public.stores add column if not exists terms_accepted_at timestamptz;

-- ============================================================
-- 36. Publish review gate. Until now, "Publish Your Store"
-- (js/pages/manager.js renderPublishBanner()/publishStore()) set
-- is_published = true directly the instant the manager clicked it,
-- once the setup checklist (5+ menu items, logo, cover photo) was
-- complete — no human ever looked at the actual menu photos/content
-- before it went live to real customers. This section turns that one
-- click into a REQUEST a developer must review and approve, exactly
-- mirroring the existing store-application and menu-item approval
-- flows already in this file (sections 19/20) — same shape, one more
-- gate. is_published itself now becomes developer-only to change (a
-- manager could previously set it directly via a raw client update,
-- since "stores update own" has no column-level restriction — that
-- gap is closed here, not just routed around client-side).
-- ============================================================
alter table public.stores add column if not exists publish_requested_at timestamptz;
alter table public.stores add column if not exists publish_rejection_reason text;

create or replace function public.protect_publish_gate()
returns trigger
language plpgsql
as $$
begin
  -- Same auth.uid() is null bypass as enforce_store_status() above —
  -- direct SQL / table-editor fixes run as the table owner, not a real
  -- app session, and must never be blocked by this.
  if auth.uid() is null then
    return new;
  end if;
  if new.is_published is distinct from old.is_published and public.current_role() is distinct from 'developer' then
    new.is_published := old.is_published;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_publish_gate on public.stores;
create trigger trg_protect_publish_gate
  before update on public.stores
  for each row execute procedure public.protect_publish_gate();

-- ============================================================
-- 37. Scalability indexes — targets the queries that actually run on
-- EVERY page load for EVERY visitor (App.Bootstrap.loadPublicData() in
-- the customer app: Stores.fetchAll()/Menu.fetchAll(), filtered
-- server-side by RLS to approved+published stores and approved menu
-- items), plus the other genuinely hot lookups (profiles by role/status
-- — driver/developer approval queues and the customer-count stat all
-- filter on this with no index today; orders/audit_log ordered by
-- created_at with no index backing that sort; reviews by store_id for
-- the rating rollup). None of this changes behavior — pure additive
-- indexes, safe to run any time, purely a query-speed fix for handling
-- meaningfully more concurrent users than the handful of real rows this
-- project has had so far.
-- ============================================================
create index if not exists idx_stores_status_published on public.stores(status, is_published);
create index if not exists idx_stores_university on public.stores(university);
create index if not exists idx_menu_items_status on public.menu_items(status);
create index if not exists idx_profiles_role on public.profiles(role);
create index if not exists idx_profiles_role_status on public.profiles(role, status);
create index if not exists idx_orders_created_at on public.orders(created_at desc);
create index if not exists idx_audit_log_created_at on public.audit_log(created_at desc);
create index if not exists idx_reviews_store on public.reviews(store_id);

-- ============================================================
-- 38. Auto-accept + honest dynamic ETA. A kitchen previously had to
-- manually click "Start Preparing" on every single order before it
-- entered the queue (js/pages/kitchen.js, the 'received' -> 'preparing'
-- step) — real, human, one-click-per-order bottleneck: a burst of 50
-- simultaneous orders is 50 clicks no kitchen can do instantly, no
-- matter how fast the database is. Orders now go straight to
-- 'preparing' the moment they're placed (the app still logs a
-- 'received' history entry first, same instant, so the tracker's
-- step-by-step display is unchanged) — the kitchen's real queue is
-- exactly what's actually there, nothing gated behind a click.
--
-- estimated_ready_at is computed HERE, server-side, at insert time —
-- not a static store.prep_time_max shown to every customer regardless
-- of how busy the kitchen actually is. It's the store's own prep time
-- PLUS a real per-order delay for every order already ahead of this one
-- in that store's queue (status='preparing', not yet ready/cancelled),
-- so a customer ordering into a slammed kitchen sees an honestly longer
-- estimate instead of a number the kitchen can't possibly hit.
-- ============================================================
alter table public.orders add column if not exists estimated_ready_at timestamptz;

create or replace function public.set_order_estimated_ready_at()
returns trigger
language plpgsql
as $$
declare
  queue_ahead int;
  store_prep_max int;
  minutes_per_queued_order numeric := 3; -- realistic added kitchen time per order already ahead in the queue
begin
  select coalesce(prep_time_max, 20) into store_prep_max from public.stores where id = new.store_id;
  select count(*) into queue_ahead from public.orders
    where store_id = new.store_id and status = 'preparing';
  new.estimated_ready_at := now() + (coalesce(store_prep_max, 20) + coalesce(queue_ahead, 0) * minutes_per_queued_order) * interval '1 minute';
  return new;
end;
$$;

drop trigger if exists trg_set_order_estimated_ready_at on public.orders;
create trigger trg_set_order_estimated_ready_at
  before insert on public.orders
  for each row execute procedure public.set_order_estimated_ready_at();

-- ============================================================
-- SECTION 39: One email = one account, enforced at the database level
-- (2026-09-22)
--
-- This was ALREADY true structurally before this section: all three
-- clickFud apps (customer/staff/developer) share this one Supabase
-- project, every one of them creates accounts exclusively through
-- App.sb.auth.signUp() (confirmed — no admin.createUser or direct
-- profiles insert anywhere in any of the three codebases), and
-- Supabase Auth itself already enforces email uniqueness at the
-- database level regardless of role:
--   - auth.users has a real UNIQUE index on email (users_email_partial_key,
--     WHERE is_sso_user = false) — a second signUp() with the same email
--     is rejected by Postgres itself, atomically, so two near-simultaneous
--     registration requests cannot both succeed (the unique index is
--     what actually resolves the race, not application code).
--   - GoTrue (Supabase's auth server) normalizes email to lowercase
--     before this check, so "Test@Example.com" and "test@example.com"
--     already collide as the same account.
--   - public.profiles.id is a 1:1 FK to auth.users.id, and the
--     on_auth_user_created trigger's `insert ... on conflict (id) do
--     nothing` means a profile can only ever be created alongside a
--     genuinely new, unique auth user — never a second profile for an
--     existing identity, regardless of what role is requested.
-- Verified live before writing this: zero duplicate emails existed in
-- auth.users at the time this was added.
--
-- What THIS section adds is defense-in-depth, not a fix for a real
-- bypass: a matching case-insensitive unique index directly on
-- public.profiles.email, so the uniqueness rule is enforced at both
-- layers a query might ever touch, not just auth.users.
-- ============================================================
create unique index if not exists idx_profiles_email_unique
  on public.profiles (lower(email))
  where email is not null;

-- ============================================================
-- SECTION 40: Home page media — three developer-uploaded images that
-- fill the decorative hero/about/"Hungry Between Lectures" panels on
-- the customer app's public marketing homepage (js/pages/home.js
-- mHeroSection()/mAboutSection()/mLecturesSection()). Those panels are
-- plain CSS gradients until a developer uploads a real photo for that
-- slot — never a fabricated stock image. Same pattern as top_adverts
-- (section 28): developer-only writes, public reads, reuses the
-- existing images/video storage buckets (developer already has
-- blanket write access there, no new storage policy needed).
-- ============================================================
create table if not exists public.home_page_media (
  id uuid primary key default gen_random_uuid(),
  slot text not null unique check (slot in ('hero', 'about', 'lectures')),
  image_url text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table public.home_page_media enable row level security;

drop policy if exists "home_page_media select" on public.home_page_media;
create policy "home_page_media select" on public.home_page_media
  for select using (true);

drop policy if exists "home_page_media developer insert" on public.home_page_media;
create policy "home_page_media developer insert" on public.home_page_media
  for insert with check (public.current_role() = 'developer');

drop policy if exists "home_page_media developer update" on public.home_page_media;
create policy "home_page_media developer update" on public.home_page_media
  for update using (public.current_role() = 'developer') with check (public.current_role() = 'developer');

drop policy if exists "home_page_media developer delete" on public.home_page_media;
create policy "home_page_media developer delete" on public.home_page_media
  for delete using (public.current_role() = 'developer');

create or replace function public.touch_home_page_media_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_home_page_media_updated_at on public.home_page_media;
create trigger trg_home_page_media_updated_at
  before update on public.home_page_media
  for each row execute function public.touch_home_page_media_updated_at();

alter table public.images drop constraint if exists images_kind_check;
alter table public.images add constraint images_kind_check
  check (kind in ('logo','cover','menu_item','promotion','addon','top_advert','home_page_media'));

-- ============================================================
-- SECTION 41: Home page media — editable captions. The developer
-- previously had no way to change the fixed "About clickFud"/"Hungry
-- Between Lectures?" titles and subtitles baked into
-- js/pages/home.js — these two columns let the About and Lectures
-- slots carry their own developer-written title/subtitle, read back
-- by App.HomePageMedia.fetchAll() alongside image_url. The hero slot
-- deliberately keeps its own fixed headline in js/pages/home.js —
-- these columns exist for it too (same table, no per-slot schema) but
-- the Developer app's form only exposes them for 'about'/'lectures'.
-- Nothing here is retroactively required — both columns are nullable,
-- and js/pages/home.js falls back to its existing default title/
-- subtitle for a slot until a developer explicitly sets one.
-- ============================================================
alter table public.home_page_media add column if not exists title text;
alter table public.home_page_media add column if not exists subtitle text;

-- ============================================================
-- 34. FIX — finalize_paystack_checkout() created real, paid order rows
-- but never inserted a notifications row for the customer at all. A cash
-- order gets a "received — the kitchen is preparing it now!" notification
-- from App.Orders.createOrder() client-side; a card order that just went
-- through this function got nothing — no confirmation that the payment
-- (and the order) genuinely succeeded, in-app. Fixed by inserting one
-- notification per order created in the loop, worded specifically as a
-- PAYMENT confirmation (not just "order received") since that's the
-- thing this function's caller (paystack-verify / paystack-webhook) is
-- actually confirming that createOrder()'s COD path never had to.
-- ============================================================
create or replace function public.finalize_paystack_checkout(p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.checkout_sessions;
  v_group jsonb;
  v_order public.orders;
  v_order_ids jsonb := '[]'::jsonb;
begin
  select * into v_session from public.checkout_sessions where reference = p_reference for update;
  if not found then
    raise exception 'Unknown checkout session.';
  end if;

  if v_session.status = 'paid' then
    return jsonb_build_object('order_ids', v_session.order_ids);
  end if;

  for v_group in select * from jsonb_array_elements(v_session.groups)
  loop
    insert into public.orders (
      customer_id, store_id, items, subtotal, delivery_fee, discount, promo_code, total,
      payment_method, payment_status, payment_reference, delivery_location, status, status_history,
      paystack_subaccount_code, payout_amount, platform_fee_amount
    ) values (
      v_session.customer_id,
      (v_group->>'storeId')::uuid,
      v_group->'items',
      (v_group->>'subtotal')::numeric,
      0,
      coalesce((v_group->>'discount')::numeric, 0),
      v_group->>'promoCode',
      (v_group->>'total')::numeric,
      'card',
      'paid',
      p_reference,
      v_group->'deliveryLocation',
      'received',
      jsonb_build_array(jsonb_build_object('status', 'received', 'at', now())),
      v_group->>'subaccountCode',
      (v_group->>'shopAmount')::numeric,
      coalesce((v_group->>'platformFeeAmount')::numeric, 0)
    )
    returning * into v_order;

    v_order_ids := v_order_ids || to_jsonb(v_order.id);

    insert into public.notifications (user_id, message, type)
    values (
      v_session.customer_id,
      'Payment successful! Your order ' || v_order.order_number || ' has been successfully placed.',
      'order_received'
    );
  end loop;

  update public.checkout_sessions
    set status = 'paid', order_ids = v_order_ids, updated_at = now()
    where reference = p_reference;

  return jsonb_build_object('order_ids', v_order_ids);
end;
$$;

-- ============================================================
-- 35. FIX — finalize_paystack_checkout() created card-paid orders with
-- status 'received'. The COD path (App.Orders.createOrder(), js/orders.js)
-- has always created orders at status 'preparing' directly (auto-accept,
-- section 38) — 'received' only ever appears as a status_history entry,
-- never as the live status. The kitchen board (Staff app, kitchen.js)
-- was built on exactly that assumption: it only has "Preparing"/"Ready"
-- columns, deliberately with no "received" column at all ("every order
-- is already in the real queue the moment it's placed"). A card order
-- left at status='received' matched neither column and never appeared
-- on the kitchen board at all, even though the customer correctly saw
-- "order placed" — the kitchen simply never got it. Fixed to match the
-- COD path exactly: live status 'preparing', 'received' kept only in
-- status_history so the tracker's step-by-step display is unchanged.
-- ============================================================
create or replace function public.finalize_paystack_checkout(p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.checkout_sessions;
  v_group jsonb;
  v_order public.orders;
  v_order_ids jsonb := '[]'::jsonb;
begin
  select * into v_session from public.checkout_sessions where reference = p_reference for update;
  if not found then
    raise exception 'Unknown checkout session.';
  end if;

  if v_session.status = 'paid' then
    return jsonb_build_object('order_ids', v_session.order_ids);
  end if;

  for v_group in select * from jsonb_array_elements(v_session.groups)
  loop
    insert into public.orders (
      customer_id, store_id, items, subtotal, delivery_fee, discount, promo_code, total,
      payment_method, payment_status, payment_reference, delivery_location, status, status_history,
      paystack_subaccount_code, payout_amount, platform_fee_amount
    ) values (
      v_session.customer_id,
      (v_group->>'storeId')::uuid,
      v_group->'items',
      (v_group->>'subtotal')::numeric,
      0,
      coalesce((v_group->>'discount')::numeric, 0),
      v_group->>'promoCode',
      (v_group->>'total')::numeric,
      'card',
      'paid',
      p_reference,
      v_group->'deliveryLocation',
      'preparing',
      jsonb_build_array(jsonb_build_object('status', 'received', 'at', now()), jsonb_build_object('status', 'preparing', 'at', now())),
      v_group->>'subaccountCode',
      (v_group->>'shopAmount')::numeric,
      coalesce((v_group->>'platformFeeAmount')::numeric, 0)
    )
    returning * into v_order;

    v_order_ids := v_order_ids || to_jsonb(v_order.id);

    insert into public.notifications (user_id, message, type)
    values (
      v_session.customer_id,
      'Payment successful! Your order ' || v_order.order_number || ' has been successfully placed.',
      'order_received'
    );
  end loop;

  update public.checkout_sessions
    set status = 'paid', order_ids = v_order_ids, updated_at = now()
    where reference = p_reference;

  return jsonb_build_object('order_ids', v_order_ids);
end;
$$;

-- ============================================================
-- 36. FIX — confirm_collection() only checked that cash_tendered wasn't
-- negative; staff could confirm a COD collection with ANY cash amount
-- entered (too much, too little, or blank), with nothing stopping it.
-- For a cash order, the amount actually handed over must exactly match
-- the order's real total (a 0.005 tolerance only covers floating-point
-- rounding, never a genuine short/over payment) or the collection is
-- refused outright — enforced here server-side, not just as a frontend
-- hint, so it can't be bypassed by calling the RPC directly.
-- ============================================================
create or replace function public.confirm_collection(p_order_id uuid, p_code text, p_cash_tendered numeric default null)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_input text;
begin
  if public.current_role() not in ('manager', 'kitchen') then
    raise exception 'Not authorised to confirm collection.';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  if v_order.store_id is distinct from public.current_store_id() then
    raise exception 'This order does not belong to your store.';
  end if;
  if v_order.status = 'collected' then
    raise exception 'Order has already been collected.';
  end if;
  if v_order.status <> 'ready' then
    raise exception 'Order is not ready for collection yet.';
  end if;

  v_input := upper(trim(coalesce(p_code, '')));
  if v_input = '' or v_order.collection_code is null
     or v_input not in (upper(v_order.collection_code), upper(v_order.collection_token::text)) then
    raise exception 'Invalid collection code.';
  end if;

  if p_cash_tendered is not null and p_cash_tendered < 0 then
    raise exception 'Cash received cannot be negative.';
  end if;

  if v_order.payment_method = 'cod' then
    if p_cash_tendered is null then
      raise exception 'Please enter the exact cash received before confirming collection.';
    end if;
    if abs(p_cash_tendered - v_order.total) > 0.005 then
      raise exception 'Cash received (R%) does not match the order total (R%) — enter the exact amount.',
        trim(to_char(p_cash_tendered, 'FM999999990.00')), trim(to_char(v_order.total, 'FM999999990.00'));
    end if;
  end if;

  update public.orders
    set status = 'collected',
        status_history = coalesce(v_order.status_history, '[]'::jsonb) || jsonb_build_object('status', 'collected', 'at', now()),
        payment_status = 'paid',
        cash_tendered = coalesce(p_cash_tendered, v_order.cash_tendered),
        collected_at = now(),
        collected_by = auth.uid()
    where id = p_order_id
    returning * into v_order;

  insert into public.notifications (user_id, message, type)
  values (v_order.customer_id, 'Order ' || v_order.order_number || ' collected. Enjoy your meal!', 'delivered');

  return v_order;
end;
$$;

-- ============================================================
-- 37. NEW — Saved payment methods (wallet). PCI-compliant by
-- construction: this table only ever stores what Paystack's own
-- verification response gives back about a REUSABLE card authorization
-- (paystack_authorization_code — an opaque token, not the card itself
-- — plus bank/card_type/last4/exp for display). Raw card number, CVV
-- and PIN never pass through our servers at all; Paystack's hosted
-- checkout/SDK collects them directly, matching Paystack's own current
-- documented flow (initialize -> Checkout -> verify). Written ONLY by
-- edge functions (service role) right after a real, verified Paystack
-- transaction — never by a raw client insert, so a customer can't
-- fabricate a "saved card" for themselves.
-- ============================================================
create table if not exists public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles (id) on delete cascade,
  paystack_authorization_code text not null,
  card_type text,
  bank text,
  last4 text,
  exp_month text,
  exp_year text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (customer_id, paystack_authorization_code)
);

create index if not exists payment_methods_customer_id_idx on public.payment_methods (customer_id);

alter table public.payment_methods enable row level security;

drop policy if exists "payment_methods select own" on public.payment_methods;
create policy "payment_methods select own"
  on public.payment_methods for select
  using (customer_id = auth.uid());

-- Deleting/renaming-default is safe for a customer to do to their own
-- row directly — no card data involved, just their own reference to it.
drop policy if exists "payment_methods delete own" on public.payment_methods;
create policy "payment_methods delete own"
  on public.payment_methods for delete
  using (customer_id = auth.uid());

drop policy if exists "payment_methods update own default flag" on public.payment_methods;
create policy "payment_methods update own default flag"
  on public.payment_methods for update
  using (customer_id = auth.uid())
  with check (customer_id = auth.uid());
-- No insert policy at all for authenticated/anon — only service role
-- (paystack-verify, after real verification) ever creates a row here.

-- Keeps "is_default" meaningful (at most one true per customer) without
-- trusting the client to unset the others itself.
create or replace function public.set_default_payment_method()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_default then
    update public.payment_methods set is_default = false
      where customer_id = new.customer_id and id <> new.id and is_default = true;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_default_payment_method on public.payment_methods;
create trigger trg_set_default_payment_method
  before insert or update on public.payment_methods
  for each row execute function public.set_default_payment_method();

-- ============================================================
-- Section 39: Payment event log (audit trail for payment/webhook
-- processing — never contains card data, since none of the
-- paystack-* functions ever touch it). Append-only, service-role
-- writes only, developer-only reads. Applied via the Management API
-- 2026-09-24.
-- ============================================================
create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  source text not null,
  reference text,
  order_id uuid references public.orders (id) on delete set null,
  customer_id uuid references public.profiles (id) on delete set null,
  status text,
  failure_reason text,
  created_at timestamptz not null default now()
);
create index if not exists payment_events_reference_idx on public.payment_events (reference);
create index if not exists payment_events_order_id_idx on public.payment_events (order_id);
create index if not exists payment_events_created_at_idx on public.payment_events (created_at desc);

alter table public.payment_events enable row level security;

drop policy if exists "payment_events select developer" on public.payment_events;
create policy "payment_events select developer"
  on public.payment_events for select
  using (public."current_role"() = 'developer');
-- No insert/update/delete policy for anon/authenticated at all —
-- only service role (edge functions) ever writes a row here.

-- ============================================================
-- Section 40: failure_reason on checkout_sessions, and a refund
-- lifecycle that follows Paystack's documented behaviour — a
-- successful POST /refund response only means the refund was
-- QUEUED, not completed (confirmed against Paystack's current
-- docs/support articles). orders.payment_status gains two new
-- values used only during that window: 'refund_pending' (set the
-- moment Paystack accepts the refund request, by
-- paystack-cancel-order) and 'refund_failed' (set if Paystack's
-- async processing fails it) — 'refunded' is now only ever set by
-- paystack-webhook once Paystack's refund.processed event confirms
-- completion. No existing UI treated anything other than the
-- literal string 'paid' as success, so this is a safe additive
-- change, not a changed meaning of an existing value.
-- ============================================================
alter table public.checkout_sessions add column if not exists failure_reason text;

drop function if exists public.mark_paystack_checkout_failed(text);
create function public.mark_paystack_checkout_failed(p_reference text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.checkout_sessions
    set status = 'failed', failure_reason = coalesce(p_reason, failure_reason), updated_at = now()
    where reference = p_reference and status = 'pending';
end;
$$;

-- ============================================================
-- Section 41: Per-menu-item developer platform fee, replacing the
-- percentage-based commission_percent for pricing purposes (explicit
-- decision — commission_percent stays in the stores table but is no
-- longer applied to checkout pricing; paystack-initialize and
-- paystack-charge-saved both now compute the platform's split share
-- as the sum of each item's own platform_fee_amount, capped at the
-- group's post-discount total so a promo discount is always absorbed
-- by the shop's own share first). The developer sets a flat rand
-- amount per item at approval time (see menu-review.js's approve());
-- the customer pays price + platform_fee_amount for that item as one
-- combined price — the manager's own price is unaffected and is
-- still exactly what reaches their payout. Applied 2026-09-24.
-- ============================================================
alter table public.menu_items add column if not exists platform_fee_amount numeric not null default 0;

-- Same protection as status/approved_at/etc. — a manager updating
-- their own item can never set or change this themselves, only a
-- developer (enforced here, not just hidden in the UI).
create or replace function public.enforce_menu_item_status()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if TG_OP = 'INSERT' then
    if public.current_role() is distinct from 'developer' then
      new.status := 'pending';
      new.approved_at := null; new.approved_by := null;
      new.rejected_at := null; new.rejection_reason := null;
      new.suspended_at := null; new.suspended_by := null;
      new.platform_fee_amount := 0;
    end if;
    new.submitted_at := now();
  elsif TG_OP = 'UPDATE' then
    if public.current_role() is distinct from 'developer' then
      new.status := old.status;
      new.approved_at := old.approved_at; new.approved_by := old.approved_by;
      new.rejected_at := old.rejected_at; new.rejection_reason := old.rejection_reason;
      new.suspended_at := old.suspended_at; new.suspended_by := old.suspended_by;
      new.submitted_at := old.submitted_at;
      new.platform_fee_amount := old.platform_fee_amount;

      if old.status = 'rejected' then
        new.status := 'pending';
        new.submitted_at := now();
        new.rejected_at := null; new.rejection_reason := null;
      elsif old.status = 'approved' and (
        new.image is distinct from old.image or
        new.name is distinct from old.name or
        new.description is distinct from old.description or
        new.category is distinct from old.category or
        new.ingredients is distinct from old.ingredients or
        new.allergens is distinct from old.allergens
      ) then
        new.status := 'pending';
        new.submitted_at := now();
        new.approved_at := null; new.approved_by := null;
      end if;
    end if;
  end if;
  return new;
end;
$$;

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

-- ============================================================
-- NEW (2026-09-28) — Students can attend more than one campus
--
-- profiles.campuses holds every campus a student ticked (at least one is
-- required by the customer app before they can use it — see
-- js/pages/campus-setup.js). profiles.campus_location is kept as the
-- FIRST of those campuses, so every existing screen/query that only
-- knows about one campus (My Orientation, the Staff/Developer apps)
-- keeps working unchanged.
--
-- No new RLS policy needed: students already update their own profile
-- row through the existing "profiles update own" policy, and
-- trg_prevent_role_change only guards role/store_id.
--
-- Safe to run more than once. The customer app keeps working before this
-- is run (it saves just the first campus into campus_location).
-- ============================================================
alter table public.profiles add column if not exists campuses text[] not null default '{}';

-- Carry every existing student's single campus over into the new list.
update public.profiles
   set campuses = array[campus_location]
 where campus_location is not null
   and cardinality(campuses) = 0;

-- ============================================================
-- NEW (2026-09-29) — Share a timetable with friends by link.
--
-- A student taps "Share" on My Timetable: create_timetable_share()
-- stores a SNAPSHOT of their classes (not a live view) and returns an
-- unguessable id, sent as clickfud…/?timetable=<id> (WhatsApp etc.).
-- The friend opens it, previews it (get_timetable_share), and on accept
-- (accept_timetable_share) the classes are COPIED into the friend's own
-- timetable_entries — so reminders, directions and editing all work
-- exactly like classes they typed in themselves.
--
-- Privacy:
--   - timetable_entries RLS is unchanged: nobody can read anyone else's
--     timetable. Only what the owner chose to share, frozen at that
--     moment, is visible — and only to someone holding the link.
--   - personal `notes` are never included in a share.
--   - links expire after 30 days; the owner can revoke (revoked=true).
--   - no one can list shares: the table has no select policy for anyone
--     but the owner; previews/accepts go through the functions below.
-- ============================================================
create table if not exists public.timetable_shares (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  owner_name text,
  entries jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  revoked boolean not null default false,
  accept_count int not null default 0
);
create index if not exists idx_timetable_shares_owner on public.timetable_shares(owner_id, created_at desc);
alter table public.timetable_shares enable row level security;

drop policy if exists "timetable shares owner select" on public.timetable_shares;
create policy "timetable shares owner select" on public.timetable_shares
  for select using (owner_id = (select auth.uid()));
drop policy if exists "timetable shares owner revoke" on public.timetable_shares;
create policy "timetable shares owner revoke" on public.timetable_shares
  for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
-- No insert/delete policies: shares are only ever created by the function below.

-- ---- create: snapshot the caller's own classes ----
create or replace function public.create_timetable_share()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_entries jsonb;
  v_name text;
  v_id uuid;
begin
  if v_uid is null then raise exception 'Please sign in to share your timetable.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'module', module, 'module_code', module_code, 'class_type', class_type,
      'day_of_week', day_of_week, 'specific_date', specific_date,
      'start_time', to_char(start_time, 'HH24:MI'), 'end_time', to_char(end_time, 'HH24:MI'),
      'campus', campus, 'venue', venue, 'lecturer', lecturer
    ) order by day_of_week, start_time), '[]'::jsonb)
    into v_entries
    from public.timetable_entries where student_id = v_uid;
  if jsonb_array_length(v_entries) = 0 then
    raise exception 'Your timetable is empty — add your classes before sharing.';
  end if;
  if (select count(*) from public.timetable_shares where owner_id = v_uid and created_at > now() - interval '1 day') >= 30 then
    raise exception 'You have shared your timetable many times today — please try again tomorrow.';
  end if;
  select nullif(split_part(coalesce(name, ''), ' ', 1), '') into v_name from public.profiles where id = v_uid;
  insert into public.timetable_shares (owner_id, owner_name, entries)
    values (v_uid, v_name, v_entries) returning id into v_id;
  return v_id;
end;
$$;

-- ---- preview: anyone holding the link (signed in or not) ----
create or replace function public.get_timetable_share(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'owner_name', coalesce(s.owner_name, 'A friend'),
    'entries', s.entries,
    'class_count', jsonb_array_length(s.entries),
    'expires_at', s.expires_at,
    'is_own', s.owner_id = auth.uid()
  )
  from public.timetable_shares s
  where s.id = p_id and not s.revoked and s.expires_at > now();
$$;

-- ---- accept: copy into the CALLER's own timetable ----
-- p_mode: 'add' (keep existing classes, skip exact duplicates) or
--         'replace' (remove the caller's existing classes first).
create or replace function public.accept_timetable_share(p_id uuid, p_mode text default 'add')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_share public.timetable_shares;
  v_inserted int;
begin
  if v_uid is null then raise exception 'Please sign in to add this timetable.'; end if;
  if p_mode not in ('add', 'replace') then raise exception 'Invalid option.'; end if;
  select * into v_share from public.timetable_shares where id = p_id and not revoked and expires_at > now();
  if not found then raise exception 'This timetable link has expired or is no longer available.'; end if;
  if v_share.owner_id = v_uid then raise exception 'This is your own timetable.'; end if;

  if p_mode = 'replace' then
    delete from public.timetable_entries where student_id = v_uid;
  end if;

  with src as (
    select e->>'module' module, nullif(e->>'module_code', '') module_code, e->>'class_type' class_type,
           (e->>'day_of_week')::smallint day_of_week, nullif(e->>'specific_date', '')::date specific_date,
           (e->>'start_time')::time start_time, (e->>'end_time')::time end_time,
           e->>'campus' campus, e->>'venue' venue, nullif(e->>'lecturer', '') lecturer
    from jsonb_array_elements(v_share.entries) e
  ), ins as (
    insert into public.timetable_entries (student_id, module, module_code, class_type, day_of_week, specific_date, start_time, end_time, campus, venue, lecturer)
    select v_uid, s.module, s.module_code, s.class_type, s.day_of_week, s.specific_date, s.start_time, s.end_time, s.campus, s.venue, s.lecturer
    from src s
    where not exists (
      select 1 from public.timetable_entries t
      where t.student_id = v_uid and t.module = s.module and t.class_type = s.class_type
        and t.day_of_week = s.day_of_week and t.specific_date is not distinct from s.specific_date
        and t.start_time = s.start_time and t.end_time = s.end_time and t.venue = s.venue
    )
    returning 1
  )
  select count(*) into v_inserted from ins;

  update public.timetable_shares set accept_count = accept_count + 1 where id = p_id;
  return v_inserted;
end;
$$;

revoke all on function public.create_timetable_share() from public;
revoke all on function public.get_timetable_share(uuid) from public;
revoke all on function public.accept_timetable_share(uuid, text) from public;
grant execute on function public.create_timetable_share() to authenticated;
grant execute on function public.get_timetable_share(uuid) to anon, authenticated;
grant execute on function public.accept_timetable_share(uuid, text) to authenticated;

-- ============================================================
-- NEW (2026-09-29) — CUSTOMER accounts restricted to verified University
-- of Pretoria student emails; student number collected at sign-up.
--
-- WHY HERE: customer sign-up goes from the browser straight to Supabase
-- Auth, so the database is the only server-side point every sign-up
-- (email form, direct API call, Google OAuth) must pass through.
-- handle_new_user() already decides each new account's role; the rule is
-- applied right after that decision, ONLY when the result is 'customer'.
-- Raising an exception there rolls back the whole sign-up: no auth user,
-- no profile, no confirmation email.
--
-- WHAT IS AND ISN'T CHECKED:
--   - email must end in an approved UP student domain (up_student_email_
--     domains() — the ONE authoritative list; js/config.js mirrors it for
--     on-screen messages only).
--   - ownership of that email is proven by Supabase's existing
--     confirmation link — unconfirmed accounts cannot sign in.
--   - student number: required and format-checked (u + 8 digits). It is
--     SELF-REPORTED — nothing here claims UP has confirmed the student is
--     currently registered. No UP systems are contacted.
--
-- OTHER ROLES — UNCHANGED:
--   - manager / driver / first-developer sign-ups resolve to their own
--     role and are not affected.
--   - accounts created by an ADMIN are exempt: kitchen staff
--     (create-kitchen-staff, admin API) and dispatchers created by hand in
--     the Supabase dashboard. They are the only accounts that exist
--     already-confirmed at the moment of creation (email provider +
--     email_confirmed_at set) — a normal sign-up cannot do that while the
--     project's "Confirm email" setting is ON. KEEP IT ON: turning it off
--     would make ordinary sign-ups look admin-created and skip this rule.
--
-- EXISTING ACCOUNTS: nothing is deleted or altered. Existing non-UP
-- customers are refused at customer-app sign-in (secure-login + app),
-- per the product decision to apply the rule to everyone.
-- Safe to run more than once.
-- ============================================================

-- 1. The single authoritative list of approved student email domains.
create or replace function public.up_student_email_domains()
returns text[]
language sql
immutable
as $$ select array['tuks.co.za']::text[] $$;

create or replace function public.is_up_student_email(p_email text)
returns boolean
language sql
immutable
as $$
  select p_email is not null
     and lower(btrim(p_email)) ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'
     and split_part(lower(btrim(p_email)), '@', 2) = any (public.up_student_email_domains())
$$;
grant execute on function public.up_student_email_domains() to anon, authenticated;
grant execute on function public.is_up_student_email(text) to anon, authenticated;

-- 2. Student number on the profile (new, nullable: existing rows untouched).
alter table public.profiles add column if not exists student_number text;
do $$ begin
  alter table public.profiles add constraint profiles_student_number_format
    check (student_number is null or student_number ~ '^u[0-9]{8}$');
exception when duplicate_object then null; end $$;

-- 3. handle_new_user(): IDENTICAL role logic to the live version, plus the
--    customer-only rule and storing the student number.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requested_role text;
  v_role text;
  v_status text;
  v_student_number text;
begin
  v_requested_role := coalesce(new.raw_user_meta_data->>'role', 'customer');
  v_status := 'approved';

  if v_requested_role = 'developer' then
    if exists (select 1 from public.profiles where role = 'developer') then
      v_role := 'customer';
    else
      v_role := 'developer';
    end if;
  elsif v_requested_role = 'manager' then
    v_role := 'manager';
  elsif v_requested_role = 'driver' then
    v_role := 'driver';
    v_status := 'pending';
  else
    v_role := 'customer';
  end if;

  -- Normalise "U12345678" / "12345678" / " u1234 5678 " -> "u12345678".
  -- Only "u" + digits/spaces is accepted; anything else counts as missing.
  v_student_number := lower(coalesce(new.raw_user_meta_data->>'student_number', ''));
  if v_student_number ~ '^\s*u?[0-9\s]+$' then
    v_student_number := 'u' || regexp_replace(v_student_number, '[^0-9]', '', 'g');
  else
    v_student_number := null;
  end if;

  if v_student_number is not null and v_student_number !~ '^u[0-9]{8}$' then
    v_student_number := null; -- never let a malformed value block a non-customer sign-up
  end if;

  insert into public.profiles (id, name, email, role, phone, store_id, university, campus_location, status, avatar_url, student_number)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
    new.email,
    v_role,
    new.raw_user_meta_data->>'phone',
    null,
    new.raw_user_meta_data->>'university',
    new.raw_user_meta_data->>'campus_location',
    v_status,
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture'),
    case when v_role = 'customer' then v_student_number else null end
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

-- 3b. THE ENFORCEMENT — a deferred check, run at the END of the sign-up
--     transaction (not at the first INSERT).
--
--     Why deferred: Supabase inserts every new auth user unconfirmed and
--     only then, still inside the same transaction, either marks it
--     confirmed (admin-created: create-kitchen-staff, dashboard "Add user"
--     with auto-confirm) or records the confirmation email (normal
--     sign-up). At INSERT time the two look identical; at COMMIT they
--     don't. Raising here aborts the whole transaction — no auth user, no
--     profile, and the confirmation email is never sent.
--
--     Applies only when the account's role ended up 'customer':
--       - provider 'email' + still unconfirmed at commit = a real sign-up
--         -> needs a UP student email AND a valid student number;
--       - any other provider (Google…) -> needs a UP student email (the
--         student number is asked once in the app: no form on that path);
--       - provider 'email' + already confirmed at commit = created by an
--         admin -> exempt (kitchen staff, dispatchers). A normal sign-up
--         can't be confirmed at commit while "Confirm email" is ON.
create or replace function public.enforce_customer_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user record;
  v_role text;
  v_student_number text;
  v_provider text;
begin
  -- A deferred trigger's NEW is the row as first inserted; read the final state.
  select id, email, email_confirmed_at, raw_app_meta_data into v_user from auth.users where id = new.id;
  if not found then return null; end if;
  select role, student_number into v_role, v_student_number from public.profiles where id = new.id;
  if coalesce(v_role, 'customer') <> 'customer' then return null; end if;

  v_provider := coalesce(v_user.raw_app_meta_data->>'provider', 'email');
  if v_provider = 'email' and v_user.email_confirmed_at is not null then
    return null; -- created by an admin (see above)
  end if;

  if not public.is_up_student_email(v_user.email) then
    raise exception 'UP_STUDENT_EMAIL_REQUIRED: customer accounts need a University of Pretoria student email'
      using errcode = 'check_violation';
  end if;
  if v_provider = 'email' and (v_student_number is null or v_student_number !~ '^u[0-9]{8}$') then
    raise exception 'UP_STUDENT_NUMBER_REQUIRED: a valid student number is required'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
drop trigger if exists trg_enforce_customer_signup on auth.users;
create constraint trigger trg_enforce_customer_signup
  after insert on auth.users
  deferrable initially deferred
  for each row execute function public.enforce_customer_signup();

-- 4. A customer can't move their account to a non-UP email afterwards.
create or replace function public.enforce_customer_email_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.profiles p where p.id = new.id and p.role = 'customer') then
    if new.email is distinct from old.email and not public.is_up_student_email(new.email) then
      raise exception 'UP_STUDENT_EMAIL_REQUIRED: customer accounts need a University of Pretoria student email'
        using errcode = 'check_violation';
    end if;
    if new.email_change is distinct from old.email_change and coalesce(new.email_change, '') <> ''
       and not public.is_up_student_email(new.email_change) then
      raise exception 'UP_STUDENT_EMAIL_REQUIRED: customer accounts need a University of Pretoria student email'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_enforce_customer_email_change on auth.users;
create trigger trg_enforce_customer_email_change
  before update of email, email_change on auth.users
  for each row execute function public.enforce_customer_email_change();


-- ============================================================
-- NEW (2026-09-29) — PROMO CODES ARE FOR ONE SPECIFIC PRODUCT
--
-- A promo code now belongs to one menu item (and so to that item's
-- shop). The discount is worked out ONLY on that product's lines in the
-- cart — never the rest of the shop's items or other shops' items.
--   percentage: X% of (that product's price incl. extras x qty)
--   fixed:      R X off, at most that product's line total (once per order)
-- Enforced here (validate_order_pricing caps every order's discount) and
-- mirrored in paystack-initialize / paystack-charge-saved and the
-- customer app (js/promotions.js).
--
-- Managers only see/edit their OWN shop's codes, and can only attach a
-- code to their own shop's products. Existing codes with no product
-- (legacy, whole-order) keep working as before but can't be switched on
-- again without choosing a product.
-- Safe to run more than once.
-- ============================================================

alter table public.promotions add column if not exists menu_item_id uuid references public.menu_items(id) on delete cascade;
alter table public.promotions add column if not exists store_id uuid references public.stores(id) on delete cascade;
create index if not exists promotions_store_id_idx on public.promotions(store_id);

-- store_id is always derived from the product, never trusted from the client.
create or replace function public.enforce_promo_product()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid;
begin
  if new.menu_item_id is null then
    new.store_id := null;
    if auth.uid() is not null and (tg_op = 'INSERT' or new.active) then
      raise exception 'Choose the product this promo code is for.' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  select store_id into v_store from public.menu_items where id = new.menu_item_id;
  if v_store is null then
    raise exception 'That product no longer exists.' using errcode = 'check_violation';
  end if;
  if auth.uid() is not null and public.current_role() = 'manager' and v_store is distinct from public.current_store_id() then
    raise exception 'You can only create promo codes for your own shop''s products.' using errcode = 'check_violation';
  end if;
  new.store_id := v_store;
  return new;
end;
$$;
drop trigger if exists trg_enforce_promo_product on public.promotions;
create trigger trg_enforce_promo_product
  before insert or update on public.promotions
  for each row execute function public.enforce_promo_product();

-- Managers: only their own shop's codes (plus old product-less codes, so
-- they can still be fixed or deleted).
drop policy if exists "promos manager write" on public.promotions;
create policy "promos manager write" on public.promotions
  for all
  using (public.current_role() = 'manager' and (store_id = public.current_store_id() or store_id is null))
  with check (public.current_role() = 'manager' and (store_id = public.current_store_id() or (store_id is null and not active)));

create or replace function public.validate_order_pricing()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_item jsonb;
  v_items jsonb := '[]'::jsonb;
  v_menu_item public.menu_items;
  v_addon public.menu_addons;
  v_addons_total numeric(10,2);
  v_addons_out jsonb;
  v_addon_obj jsonb;
  v_extra_id uuid;
  v_item_extra public.item_extras;
  v_unit_price numeric(10,2);
  v_qty int;
  v_subtotal numeric(10,2) := 0;
  v_promo public.promotions;
  v_max_discount numeric(10,2);
  v_eligible numeric(10,2);
begin
  if new.store_id is null then
    raise exception 'Order must belong to a store.';
  end if;
  if jsonb_array_length(coalesce(new.items, '[]'::jsonb)) = 0 then
    raise exception 'Order must contain at least one item.';
  end if;

  for v_item in select * from jsonb_array_elements(new.items)
  loop
    v_qty := greatest(1, coalesce((v_item->>'qty')::int, 1));

    if coalesce((v_item->>'isAddon')::boolean, false) then
      select * into v_addon from public.menu_addons
        where id = (v_item->>'menuItemId')::uuid and store_id = new.store_id;
      if not found or not v_addon.is_available then
        raise exception 'One or more add-ons in this order are no longer available.';
      end if;
      v_unit_price := v_addon.price;
      v_addons_out := '[]'::jsonb;
    else
      select * into v_menu_item from public.menu_items
        where id = (v_item->>'menuItemId')::uuid and store_id = new.store_id;
      if not found or not v_menu_item.available then
        raise exception 'One or more items in this order are no longer available.';
      end if;
      if v_menu_item.stock < v_qty then
        raise exception 'Only % left of "%".', v_menu_item.stock, v_menu_item.name;
      end if;

      -- Per-product extras (public.item_extras / public.item_extra_links,
      -- manager-configured - never a fixed/hardcoded list). Every extra id
      -- the client sent is re-looked-up here: it must be linked to THIS
      -- exact menu item, belong to this store, and currently be
      -- available, or the whole order is rejected. The name/price stored
      -- on the order always come from this live lookup, never from
      -- whatever the client sent - a tampered name or price can't slip
      -- through even if a tampered id happens to resolve to something.
      v_addons_total := 0;
      v_addons_out := '[]'::jsonb;
      if jsonb_typeof(v_item->'addons') = 'array' then
        for v_addon_obj in select * from jsonb_array_elements(v_item->'addons')
        loop
          begin
            v_extra_id := (v_addon_obj->>'id')::uuid;
          exception when others then
            raise exception 'Invalid extra selection.';
          end;
          select ie.* into v_item_extra from public.item_extras ie
            join public.item_extra_links iel on iel.item_extra_id = ie.id
            where ie.id = v_extra_id
              and iel.menu_item_id = v_menu_item.id
              and ie.store_id = new.store_id
              and ie.available = true;
          if not found then
            raise exception 'One or more selected extras are no longer available for "%".', v_menu_item.name;
          end if;
          v_addons_total := v_addons_total + v_item_extra.price;
          v_addons_out := v_addons_out || jsonb_build_object('id', v_item_extra.id, 'name', v_item_extra.name, 'price', v_item_extra.price);
        end loop;
      end if;

      v_unit_price := v_menu_item.price + v_addons_total;
    end if;

    v_items := v_items || jsonb_build_object(
      'menuItemId', v_item->>'menuItemId',
      'name', v_item->>'name',
      'price', round(v_unit_price, 2),
      'qty', v_qty,
      'image', v_item->'image',
      'addons', v_addons_out,
      'specialInstructions', coalesce(v_item->>'specialInstructions', ''),
      'isAddon', coalesce((v_item->>'isAddon')::boolean, false)
    );
    v_subtotal := v_subtotal + round(v_unit_price, 2) * v_qty;
  end loop;

  new.items := v_items;
  new.subtotal := round(v_subtotal, 2);
  new.delivery_fee := round(coalesce(new.delivery_fee, 0), 2);

  if new.promo_code is not null then
    select * into v_promo from public.promotions where code = new.promo_code;
    if not found or not v_promo.active
       or (v_promo.expires_at is not null and v_promo.expires_at < now())
       or (v_promo.usage_limit is not null and v_promo.used_count >= v_promo.usage_limit) then
      v_max_discount := 0;
      new.promo_code := null;
    else
      -- Product-specific code: only that product's lines count (its price
      -- + extras + platform fee, as the customer was charged). A legacy
      -- code with no product still counts the whole order.
      if v_promo.menu_item_id is null then
        v_eligible := new.subtotal;
      else
        select coalesce(sum(((e->>'price')::numeric + coalesce(mi.platform_fee_amount, 0)) * (e->>'qty')::int), 0)
          into v_eligible
          from jsonb_array_elements(v_items) e
          join public.menu_items mi on mi.id = v_promo.menu_item_id
          where e->>'menuItemId' = v_promo.menu_item_id::text
            and not coalesce((e->>'isAddon')::boolean, false);
      end if;
      if v_eligible <= 0 then
        v_max_discount := 0;
        new.promo_code := null;
      elsif v_promo.type = 'percentage' then
        v_max_discount := round(v_eligible * (v_promo.value / 100), 2);
      else
        v_max_discount := least(v_promo.value, v_eligible);
      end if;
    end if;
    new.discount := least(greatest(coalesce(new.discount, 0), 0), v_max_discount);
  else
    new.discount := 0;
  end if;

  new.total := greatest(0, new.subtotal + new.delivery_fee - new.discount);

  return new;
end;
$function$;


-- ============================================================
-- NEW (2026-09-29) — A PROMO CODE CAN COVER SEVERAL PRODUCTS
--
-- Replaces the single promotions.menu_item_id (promo_products.sql, same
-- day) with a list: promotions.menu_item_ids. The manager ticks the
-- products the code is for; the discount is worked out ONLY on those
-- products' lines in the cart.
--   percentage: X% of (those products' price incl. extras x qty)
--   fixed:      R X off once per order, at most those products' total
-- All chosen products must belong to ONE shop (the manager's own); the
-- code's store_id is derived from them. Mirrored in paystack-initialize /
-- paystack-charge-saved and js/promotions.js.
-- Safe to run more than once.
-- ============================================================

alter table public.promotions add column if not exists menu_item_ids uuid[];
alter table public.promotions add column if not exists store_id uuid references public.stores(id) on delete cascade;
create index if not exists promotions_store_id_idx on public.promotions(store_id);
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'promotions' and column_name = 'menu_item_id') then
    update public.promotions set menu_item_ids = array[menu_item_id] where menu_item_id is not null and menu_item_ids is null;
    alter table public.promotions drop column menu_item_id;
  end if;
end $$;

create or replace function public.enforce_promo_product()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_found int;
  v_stores int;
  v_store uuid;
begin
  -- de-duplicate, drop nulls
  new.menu_item_ids := nullif(array(select distinct x from unnest(coalesce(new.menu_item_ids, '{}'::uuid[])) x where x is not null), '{}'::uuid[]);
  if new.menu_item_ids is null then
    new.store_id := null;
    if auth.uid() is not null and (tg_op = 'INSERT' or new.active) then
      raise exception 'Choose at least one product this promo code is for.' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  select count(*), count(distinct store_id), min(store_id::text)::uuid
    into v_found, v_stores, v_store
    from public.menu_items where id = any (new.menu_item_ids);
  if v_found <> cardinality(new.menu_item_ids) then
    raise exception 'One or more of the chosen products no longer exist.' using errcode = 'check_violation';
  end if;
  if v_stores <> 1 then
    raise exception 'All products on one promo code must be from the same shop.' using errcode = 'check_violation';
  end if;
  if auth.uid() is not null and public.current_role() = 'manager' and v_store is distinct from public.current_store_id() then
    raise exception 'You can only create promo codes for your own shop''s products.' using errcode = 'check_violation';
  end if;
  new.store_id := v_store;
  return new;
end;
$$;
drop trigger if exists trg_enforce_promo_product on public.promotions;
create trigger trg_enforce_promo_product
  before insert or update on public.promotions
  for each row execute function public.enforce_promo_product();

create or replace function public.validate_order_pricing()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_item jsonb;
  v_items jsonb := '[]'::jsonb;
  v_menu_item public.menu_items;
  v_addon public.menu_addons;
  v_addons_total numeric(10,2);
  v_addons_out jsonb;
  v_addon_obj jsonb;
  v_extra_id uuid;
  v_item_extra public.item_extras;
  v_unit_price numeric(10,2);
  v_qty int;
  v_subtotal numeric(10,2) := 0;
  v_promo public.promotions;
  v_max_discount numeric(10,2);
  v_eligible numeric(10,2);
begin
  if new.store_id is null then
    raise exception 'Order must belong to a store.';
  end if;
  if jsonb_array_length(coalesce(new.items, '[]'::jsonb)) = 0 then
    raise exception 'Order must contain at least one item.';
  end if;

  for v_item in select * from jsonb_array_elements(new.items)
  loop
    v_qty := greatest(1, coalesce((v_item->>'qty')::int, 1));

    if coalesce((v_item->>'isAddon')::boolean, false) then
      select * into v_addon from public.menu_addons
        where id = (v_item->>'menuItemId')::uuid and store_id = new.store_id;
      if not found or not v_addon.is_available then
        raise exception 'One or more add-ons in this order are no longer available.';
      end if;
      v_unit_price := v_addon.price;
      v_addons_out := '[]'::jsonb;
    else
      select * into v_menu_item from public.menu_items
        where id = (v_item->>'menuItemId')::uuid and store_id = new.store_id;
      if not found or not v_menu_item.available then
        raise exception 'One or more items in this order are no longer available.';
      end if;
      if v_menu_item.stock < v_qty then
        raise exception 'Only % left of "%".', v_menu_item.stock, v_menu_item.name;
      end if;

      -- Per-product extras (public.item_extras / public.item_extra_links,
      -- manager-configured - never a fixed/hardcoded list). Every extra id
      -- the client sent is re-looked-up here: it must be linked to THIS
      -- exact menu item, belong to this store, and currently be
      -- available, or the whole order is rejected. The name/price stored
      -- on the order always come from this live lookup, never from
      -- whatever the client sent - a tampered name or price can't slip
      -- through even if a tampered id happens to resolve to something.
      v_addons_total := 0;
      v_addons_out := '[]'::jsonb;
      if jsonb_typeof(v_item->'addons') = 'array' then
        for v_addon_obj in select * from jsonb_array_elements(v_item->'addons')
        loop
          begin
            v_extra_id := (v_addon_obj->>'id')::uuid;
          exception when others then
            raise exception 'Invalid extra selection.';
          end;
          select ie.* into v_item_extra from public.item_extras ie
            join public.item_extra_links iel on iel.item_extra_id = ie.id
            where ie.id = v_extra_id
              and iel.menu_item_id = v_menu_item.id
              and ie.store_id = new.store_id
              and ie.available = true;
          if not found then
            raise exception 'One or more selected extras are no longer available for "%".', v_menu_item.name;
          end if;
          v_addons_total := v_addons_total + v_item_extra.price;
          v_addons_out := v_addons_out || jsonb_build_object('id', v_item_extra.id, 'name', v_item_extra.name, 'price', v_item_extra.price);
        end loop;
      end if;

      v_unit_price := v_menu_item.price + v_addons_total;
    end if;

    v_items := v_items || jsonb_build_object(
      'menuItemId', v_item->>'menuItemId',
      'name', v_item->>'name',
      'price', round(v_unit_price, 2),
      'qty', v_qty,
      'image', v_item->'image',
      'addons', v_addons_out,
      'specialInstructions', coalesce(v_item->>'specialInstructions', ''),
      'isAddon', coalesce((v_item->>'isAddon')::boolean, false)
    );
    v_subtotal := v_subtotal + round(v_unit_price, 2) * v_qty;
  end loop;

  new.items := v_items;
  new.subtotal := round(v_subtotal, 2);
  new.delivery_fee := round(coalesce(new.delivery_fee, 0), 2);

  if new.promo_code is not null then
    select * into v_promo from public.promotions where code = new.promo_code;
    if not found or not v_promo.active
       or (v_promo.expires_at is not null and v_promo.expires_at < now())
       or (v_promo.usage_limit is not null and v_promo.used_count >= v_promo.usage_limit) then
      v_max_discount := 0;
      new.promo_code := null;
    else
      -- Product code: only the chosen products' lines count (price
      -- + extras + platform fee, as the customer was charged). A legacy
      -- code with no product still counts the whole order.
      if coalesce(cardinality(v_promo.menu_item_ids), 0) = 0 then
        v_eligible := new.subtotal;
      else
        select coalesce(sum(((e->>'price')::numeric + coalesce(mi.platform_fee_amount, 0)) * (e->>'qty')::int), 0)
          into v_eligible
          from jsonb_array_elements(v_items) e
          join public.menu_items mi on mi.id::text = e->>'menuItemId'
          where mi.id = any (v_promo.menu_item_ids)
            and not coalesce((e->>'isAddon')::boolean, false);
      end if;
      if v_eligible <= 0 then
        v_max_discount := 0;
        new.promo_code := null;
      elsif v_promo.type = 'percentage' then
        v_max_discount := round(v_eligible * (v_promo.value / 100), 2);
      else
        v_max_discount := least(v_promo.value, v_eligible);
      end if;
    end if;
    new.discount := least(greatest(coalesce(new.discount, 0), 0), v_max_discount);
  else
    new.discount := 0;
  end if;

  new.total := greatest(0, new.subtotal + new.delivery_fee - new.discount);

  return new;
end;
$function$;


-- ============================================================
-- NEW (2026-09-29) — MISSED COLLECTION / RESCHEDULE COLLECTION
--
-- One order, one order number, start to finish. Nothing here creates an
-- order, a payment, or a charge: every step updates the SAME orders row.
--
-- Flow for a collection order (delivery orders are unaffected):
--   ready ─(window: ready_at + collection_window_minutes)─┐
--     collected by staff at any point → status 'collected' (ends everything)
--     window passes, no collection → collection_state 'expired',
--       customer asked "Are you still going to collect?" (one notification)
--       ├ "Yes" + new time → same order, collection_state 'rescheduled'
--       │    food still there → stays 'ready', new deadline = new time + window
--       │    food released    → back to 'preparing' (needs_reprep) — kitchen
--       │                        makes it again, marks it ready as usual
--       ├ "No"               → 'cancelled' (collection_state 'declined'),
--       │                        existing rules: a ready order is never
--       │                        refunded by cancelling; payment untouched
--       └ no answer within collection_response_minutes → 'uncollected'
--     rescheduled deadline passes: another expiry if reschedules remain
--     (max_collection_reschedules), otherwise status 'uncollected'.
--   'uncollected' = closed: off the kitchen board and the customer's active
--   orders, cannot be rescheduled; the row (payment, history) is kept.
--
-- Staff: 'released' (gave it away after the window) and 'reprepare' (make
-- it again — e.g. the customer walked in after it was released) via
-- staff_collection_action(). confirm_collection() is unchanged and still
-- works for any 'ready' order — it simply ends the whole workflow.
--
-- The clock runs on the SERVER: pg_cron calls expire_collection_windows()
-- every minute, so it works with the customer's app closed or offline.
-- Safe to run more than once.
-- ============================================================

-- 1. Settings (one row, id = 1)
alter table public.platform_config add column if not exists collection_window_minutes int not null default 30;
alter table public.platform_config add column if not exists max_collection_reschedules int not null default 2;
alter table public.platform_config add column if not exists collection_response_minutes int not null default 60;

-- 2. New final status
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status = any (array['received','preparing','ready','out_for_delivery','delivered','collected','cancelled','uncollected']));

-- 3. Collection tracking on the order itself
alter table public.orders add column if not exists ready_at timestamptz;
alter table public.orders add column if not exists original_ready_at timestamptz;
alter table public.orders add column if not exists collection_deadline timestamptz;
alter table public.orders add column if not exists original_collection_deadline timestamptz;
alter table public.orders add column if not exists collection_state text;
alter table public.orders add column if not exists collection_expired_at timestamptz;
alter table public.orders add column if not exists collection_response_deadline timestamptz;
alter table public.orders add column if not exists rescheduled_for timestamptz;
alter table public.orders add column if not exists rescheduled_at timestamptz;
alter table public.orders add column if not exists reschedule_reason text;
alter table public.orders add column if not exists reschedule_count int not null default 0;
alter table public.orders add column if not exists released_at timestamptz;
alter table public.orders add column if not exists needs_reprep boolean not null default false;
alter table public.orders drop constraint if exists orders_collection_state_check;
alter table public.orders add constraint orders_collection_state_check
  check (collection_state is null or collection_state = any (array['window','expired','rescheduled','reprep','declined','uncollected','collected']));
create index if not exists orders_collection_due_idx on public.orders (collection_deadline) where status = 'ready';

create or replace function public.collection_setting(p_name text)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select case p_name
    when 'window'   then coalesce((select collection_window_minutes   from public.platform_config where id = 1), 30)
    when 'max'      then coalesce((select max_collection_reschedules  from public.platform_config where id = 1), 2)
    when 'response' then coalesce((select collection_response_minutes from public.platform_config where id = 1), 60)
  end
$$;

-- "13:00" in South African time, for notification text.
create or replace function public.sa_time(p_at timestamptz)
returns text
language sql
immutable
as $$ select to_char(p_at at time zone 'Africa/Johannesburg', 'HH24:MI') $$;

-- 4. Real ready timestamp + deadline, set by the server whenever a
--    collection order becomes ready (first time, or again after re-making).
create or replace function public.track_collection_window()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deadline timestamptz;
begin
  if coalesce(new.delivery_location->>'fulfilment', '') <> 'collection' then
    return new;
  end if;
  if new.status = 'ready' and old.status is distinct from 'ready' then
    v_deadline := greatest(now(), coalesce(new.rescheduled_for, now()))
                  + make_interval(mins => public.collection_setting('window'));
    new.ready_at := now();
    new.original_ready_at := coalesce(old.original_ready_at, now());
    new.collection_deadline := v_deadline;
    new.original_collection_deadline := coalesce(old.original_collection_deadline, v_deadline);
    new.collection_state := case when coalesce(new.reschedule_count, 0) > 0 then 'rescheduled' else 'window' end;
    new.collection_response_deadline := null;
    new.needs_reprep := false;
    new.released_at := null; -- freshly made: this food is here
  end if;
  if new.status = 'collected' and old.status is distinct from 'collected' then
    new.collection_state := 'collected';
    new.collection_response_deadline := null;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_track_collection_window on public.orders;
create trigger trg_track_collection_window
  before update on public.orders
  for each row execute function public.track_collection_window();

-- 5. The clock (runs every minute from pg_cron).
create or replace function public.expire_collection_windows()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders;
  v_max int := public.collection_setting('max');
  v_resp int := public.collection_setting('response');
  n int := 0;
begin
  -- a) collection time passed, not collected
  for o in
    select * from public.orders
     where status = 'ready' and collection_state in ('window', 'rescheduled')
       and collection_deadline < now()
     for update skip locked
  loop
    if o.reschedule_count >= v_max then
      update public.orders set
        status = 'uncollected', collection_state = 'uncollected', collection_expired_at = now(),
        collection_response_deadline = null,
        status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object('status', 'uncollected', 'at', now())
       where id = o.id;
      insert into public.notifications (user_id, message, type) values (o.customer_id,
        'Your collection time for order ' || o.order_number || ' has passed and the order was not collected, so it has been closed.', 'order_uncollected');
    else
      update public.orders set
        collection_state = 'expired', collection_expired_at = now(),
        collection_response_deadline = now() + make_interval(mins => v_resp),
        status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object('status', 'collection_expired', 'at', now())
       where id = o.id;
      insert into public.notifications (user_id, message, type) values (o.customer_id,
        case when o.reschedule_count > 0
          then 'Your new collection time (' || public.sa_time(o.rescheduled_for) || ') for order ' || o.order_number || ' has passed, and your order has not been collected. Are you still going to collect your order?'
          else 'Your ' || public.collection_setting('window') || '-minute collection period for order ' || o.order_number || ' has passed, and your order has not been collected. Are you still going to collect your order?'
        end, 'collection_expired');
    end if;
    n := n + 1;
  end loop;

  -- b) asked, but no answer in time
  for o in
    select * from public.orders
     where status = 'ready' and collection_state = 'expired'
       and collection_response_deadline < now()
     for update skip locked
  loop
    update public.orders set
      status = 'uncollected', collection_state = 'uncollected', collection_response_deadline = null,
      status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object('status', 'uncollected', 'at', now())
     where id = o.id;
    insert into public.notifications (user_id, message, type) values (o.customer_id,
      'Order ' || o.order_number || ' was not collected and we did not hear back from you, so it has been closed.', 'order_uncollected');
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.expire_collection_windows() from public, anon, authenticated;

-- 6. Customer: "Yes, I'll still collect" (+ new time, optional reason) or "No".
create or replace function public.respond_missed_collection(p_order_id uuid, p_will_collect boolean, p_new_time timestamptz default null, p_reason text default null)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders;
  v_reason text := nullif(btrim(left(coalesce(p_reason, ''), 300)), '');
  v_window int := public.collection_setting('window');
  v_reprep boolean;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found or o.customer_id is distinct from auth.uid() then
    raise exception 'Order not found.';
  end if;
  if o.status = 'collected' then
    raise exception 'This order has already been collected.';
  end if;
  if o.status in ('uncollected', 'cancelled') then
    raise exception 'This order has expired and can no longer be rescheduled.';
  end if;
  if o.status <> 'ready' or o.collection_state is distinct from 'expired' then
    raise exception 'This order is not waiting for a new collection time.';
  end if;

  if not p_will_collect then
    update public.orders set
      status = 'cancelled', collection_state = 'declined', collection_response_deadline = null,
      status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object('status', 'cancelled', 'at', now(), 'reason', 'customer_will_not_collect')
     where id = o.id returning * into o;
    insert into public.notifications (user_id, message, type) values (o.customer_id,
      'Order ' || o.order_number || ' has been cancelled because you won''t be collecting it.', 'order_cancelled');
    return o;
  end if;

  if o.reschedule_count >= public.collection_setting('max') then
    raise exception 'This order cannot be rescheduled again.';
  end if;
  if p_new_time is null or p_new_time < now() - interval '2 minutes' or p_new_time > now() + interval '6 hours' then
    raise exception 'Please choose a collection time within the next 6 hours.';
  end if;

  v_reprep := o.released_at is not null;
  update public.orders set
    rescheduled_for = p_new_time,
    rescheduled_at = now(),
    reschedule_reason = v_reason,
    reschedule_count = o.reschedule_count + 1,
    collection_response_deadline = null,
    collection_state = 'rescheduled',
    status = case when v_reprep then 'preparing' else 'ready' end,
    needs_reprep = v_reprep,
    collection_deadline = case when v_reprep then null else greatest(p_new_time, now()) + make_interval(mins => v_window) end,
    status_history = coalesce(status_history, '[]'::jsonb)
      || jsonb_build_object('status', 'rescheduled', 'at', now(), 'for', p_new_time)
      || case when v_reprep then jsonb_build_array(jsonb_build_object('status', 'preparing', 'at', now(), 'reason', 'prepare_again')) else '[]'::jsonb end
   where id = o.id returning * into o;
  insert into public.notifications (user_id, message, type) values (o.customer_id,
    'Your collection has been rescheduled for ' || public.sa_time(p_new_time) || '. Your order number remains ' || o.order_number || '.'
    || case when v_reprep then ' Your order will be prepared again for your new collection time.' else '' end,
    'order_rescheduled');
  return o;
end;
$$;
revoke all on function public.respond_missed_collection(uuid, boolean, timestamptz, text) from public, anon;
grant execute on function public.respond_missed_collection(uuid, boolean, timestamptz, text) to authenticated;

-- 7. Staff: 'released' (gave the food away after the window passed) and
--    'reprepare' (make it again — customer is back / rescheduled).
create or replace function public.staff_collection_action(p_order_id uuid, p_action text)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders;
begin
  if public.current_role() not in ('manager', 'kitchen') then
    raise exception 'Not authorised.';
  end if;
  select * into o from public.orders where id = p_order_id for update;
  if not found or o.store_id is distinct from public.current_store_id() then
    raise exception 'Order not found.';
  end if;
  if o.status <> 'ready' or coalesce(o.delivery_location->>'fulfilment', '') <> 'collection' then
    raise exception 'Only a ready collection order can be changed here.';
  end if;

  if p_action = 'released' then
    if o.released_at is not null then return o; end if;
    if o.collection_deadline is null or o.collection_deadline > now() then
      raise exception 'The collection window has not passed yet.';
    end if;
    update public.orders set
      released_at = now(),
      status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object('status', 'released', 'at', now())
     where id = o.id returning * into o;
    return o;
  elsif p_action = 'reprepare' then
    update public.orders set
      status = 'preparing', needs_reprep = true, released_at = coalesce(released_at, now()),
      collection_state = case when collection_state = 'rescheduled' then 'rescheduled' else 'reprep' end,
      collection_response_deadline = null, collection_deadline = null,
      status_history = coalesce(status_history, '[]'::jsonb) || jsonb_build_object('status', 'preparing', 'at', now(), 'reason', 'prepare_again')
     where id = o.id returning * into o;
    insert into public.notifications (user_id, message, type) values (o.customer_id,
      'Your order ' || o.order_number || ' will be prepared again. We''ll let you know when it''s ready.', 'preparing');
    return o;
  end if;
  raise exception 'Unknown action.';
end;
$$;
revoke all on function public.staff_collection_action(uuid, text) from public, anon;
grant execute on function public.staff_collection_action(uuid, text) to authenticated;

-- 8. Existing ready collection orders: fill in their real ready time.
--    Ones already past their window are marked expired WITHOUT sending
--    notifications now (the app shows them the question when opened).
update public.orders o set
  ready_at = h.at, original_ready_at = h.at,
  collection_deadline = h.at + make_interval(mins => public.collection_setting('window')),
  original_collection_deadline = h.at + make_interval(mins => public.collection_setting('window')),
  collection_state = case when h.at + make_interval(mins => public.collection_setting('window')) < now() then 'expired' else 'window' end,
  collection_expired_at = case when h.at + make_interval(mins => public.collection_setting('window')) < now() then now() end,
  collection_response_deadline = case when h.at + make_interval(mins => public.collection_setting('window')) < now()
    then now() + make_interval(mins => public.collection_setting('response')) end
from (
  select id, (select (e->>'at')::timestamptz from jsonb_array_elements(status_history) e
               where e->>'status' = 'ready' order by (e->>'at')::timestamptz desc limit 1) as at
    from public.orders
   where status = 'ready' and coalesce(delivery_location->>'fulfilment', '') = 'collection' and collection_state is null
) h
where o.id = h.id and h.at is not null;

-- 9. Schedule the clock (every minute).
do $$ begin
  if exists (select 1 from cron.job where jobname = 'expire-collection-windows') then
    perform cron.unschedule('expire-collection-windows');
  end if;
  perform cron.schedule('expire-collection-windows', '* * * * *', 'select public.expire_collection_windows()');
end $$;
