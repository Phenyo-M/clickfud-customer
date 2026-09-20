create or replace function public.current_store_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select store_id from public.profiles where id = auth.uid();
$$;

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

create or replace function public.prevent_role_change()
returns trigger
language plpgsql
as $$
begin
  if new.role is distinct from old.role then
    new.role := old.role;
  end if;
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

alter table public.stores enable row level security;

drop policy if exists "stores select all" on public.stores;
create policy "stores select all" on public.stores
  for select using (true);

drop policy if exists "stores insert own" on public.stores;
create policy "stores insert own" on public.stores
  for insert with check (manager_id = auth.uid() and public.current_role() = 'manager');

drop policy if exists "stores update own" on public.stores;
create policy "stores update own" on public.stores
  for update using (manager_id = auth.uid());

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

drop policy if exists "menu manager write" on public.menu_items;
create policy "menu manager write" on public.menu_items
  for all
  using (public.current_role() = 'manager' and store_id = public.current_store_id())
  with check (public.current_role() = 'manager' and store_id = public.current_store_id());

drop policy if exists "orders select" on public.orders;
create policy "orders select" on public.orders
  for select using (
    customer_id = auth.uid()
    or public.current_role() = 'driver'
    or (public.current_role() in ('manager','kitchen','cashier') and store_id = public.current_store_id())
  );

drop policy if exists "orders staff update" on public.orders;
create policy "orders staff update" on public.orders
  for update
  using (
    public.current_role() = 'driver'
    or (public.current_role() in ('manager','kitchen','cashier') and store_id = public.current_store_id())
  );

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
