-- =========================================================================
-- ClickFood — Phase 3: customer tools (2026-10-01)
--
--  * customer_budgets + budget alerts — a student's own monthly food budget,
--    with optional notifications at 50% / 80% / 100% (once each per month,
--    only the highest newly reached one, so it never spams).
--  * Shared food lists (group favourites) — food_lists / members / items.
--    Joined with an invite code; members see each other's FIRST NAME only.
--  * Group orders — group_orders / members / items. Friends add their own
--    food; the leader locks the group and checks out once through the normal
--    checkout (so prices, payment and stock rules are exactly the same as any
--    order). Each line carries "Group G-XXXXXX · For <name>" so the kitchen
--    sees who each item is for.
--
-- "Spent" = the student's valid orders (collected, or paid and not
-- collected) minus refunds, in South African months.
-- Safe to run more than once.
-- =========================================================================

-- ---------- Budget ----------
create table if not exists public.customer_budgets (
  customer_id uuid primary key references public.profiles (id) on delete cascade,
  monthly_budget numeric(10,2) check (monthly_budget is null or (monthly_budget >= 50 and monthly_budget <= 100000)),
  alerts_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.customer_budgets enable row level security;
drop policy if exists "budget: own" on public.customer_budgets;
create policy "budget: own" on public.customer_budgets for all
  using (customer_id = auth.uid()) with check (customer_id = auth.uid());

create table if not exists public.budget_alerts_sent (
  customer_id uuid not null references public.profiles (id) on delete cascade,
  month date not null,
  threshold int not null check (threshold in (50, 80, 100)),
  sent_at timestamptz not null default now(),
  primary key (customer_id, month, threshold)
);
alter table public.budget_alerts_sent enable row level security;   -- no policies: server only

create or replace function public.month_spend(p_customer uuid, p_month date)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(o.total - coalesce(o.refund_amount, 0)), 0)
       - coalesce((select sum(r.amount) from public.refund_requests r
                   join public.orders o2 on o2.id = r.order_id
                   where r.customer_id = p_customer and r.status = 'paid'
                     and date_trunc('month', o2.created_at at time zone 'Africa/Johannesburg')::date = p_month), 0)
  from public.orders o
  where o.customer_id = p_customer
    and public.is_valid_sale(o.status, o.payment_status)
    and date_trunc('month', o.created_at at time zone 'Africa/Johannesburg')::date = p_month
$$;

create or replace function public.check_budget_alert()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  b public.customer_budgets;
  v_month date := date_trunc('month', new.created_at at time zone 'Africa/Johannesburg')::date;
  v_spent numeric;
  v_pct numeric;
  v_hit int;
begin
  if not public.is_valid_sale(new.status, new.payment_status) then return new; end if;
  if tg_op = 'UPDATE' and public.is_valid_sale(old.status, old.payment_status) then return new; end if;
  select * into b from public.customer_budgets where customer_id = new.customer_id;
  if not found or b.monthly_budget is null or not b.alerts_enabled then return new; end if;
  if v_month <> date_trunc('month', now() at time zone 'Africa/Johannesburg')::date then return new; end if;
  v_spent := public.month_spend(new.customer_id, v_month);
  v_pct := 100 * v_spent / b.monthly_budget;
  select max(t) into v_hit from unnest(array[50, 80, 100]) t
   where v_pct >= t and not exists (select 1 from public.budget_alerts_sent s where s.customer_id = new.customer_id and s.month = v_month and s.threshold = t);
  if v_hit is null then return new; end if;
  insert into public.budget_alerts_sent (customer_id, month, threshold)
  select new.customer_id, v_month, t from unnest(array[50, 80, 100]) t where t <= v_hit
  on conflict do nothing;
  insert into public.notifications (user_id, message, type)
  values (new.customer_id,
          'You''ve spent R' || to_char(v_spent, 'FM999990.00') || ' of your R' || to_char(b.monthly_budget, 'FM999990') || ' food budget this month'
          || case when v_hit >= 100 then '. You''ve reached your budget.' else ' (' || v_hit || '%).' end,
          'budget');
  return new;
end $$;
drop trigger if exists trg_check_budget_alert on public.orders;
create trigger trg_check_budget_alert after insert or update of status, payment_status on public.orders
  for each row execute function public.check_budget_alert();

-- ---------- Shared food lists ----------
create or replace function public.new_invite_code(p_prefix text)
returns text language plpgsql volatile as $$
declare
  chars text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v text := '';
begin
  for i in 1..6 loop v := v || substr(chars, 1 + floor(random() * length(chars))::int, 1); end loop;
  return p_prefix || '-' || v;
end $$;

create or replace function public.first_name_of(p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(split_part(trim(coalesce(name, '')), ' ', 1), ''), 'Student') from public.profiles where id = p_user
$$;

create table if not exists public.food_lists (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  invite_code text not null unique,
  created_at timestamptz not null default now()
);
create table if not exists public.food_list_members (
  list_id uuid not null references public.food_lists (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  display_name text not null,
  joined_at timestamptz not null default now(),
  primary key (list_id, user_id)
);
create table if not exists public.food_list_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.food_lists (id) on delete cascade,
  menu_item_id uuid not null references public.menu_items (id) on delete cascade,
  added_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (list_id, menu_item_id, added_by)
);
create index if not exists food_list_members_user_idx on public.food_list_members (user_id);
create index if not exists food_list_items_list_idx on public.food_list_items (list_id);

create or replace function public.is_list_member(p_list uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.food_list_members where list_id = p_list and user_id = auth.uid())
$$;

alter table public.food_lists enable row level security;
alter table public.food_list_members enable row level security;
alter table public.food_list_items enable row level security;
drop policy if exists "lists: members read" on public.food_lists;
create policy "lists: members read" on public.food_lists for select using (public.is_list_member(id));
drop policy if exists "lists: owner renames" on public.food_lists;
create policy "lists: owner renames" on public.food_lists for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "lists: owner deletes" on public.food_lists;
create policy "lists: owner deletes" on public.food_lists for delete using (owner_id = auth.uid());
drop policy if exists "list members: members read" on public.food_list_members;
create policy "list members: members read" on public.food_list_members for select using (public.is_list_member(list_id));
drop policy if exists "list members: leave" on public.food_list_members;
create policy "list members: leave" on public.food_list_members for delete using (user_id = auth.uid());
drop policy if exists "list items: members read" on public.food_list_items;
create policy "list items: members read" on public.food_list_items for select using (public.is_list_member(list_id));
drop policy if exists "list items: members add own" on public.food_list_items;
create policy "list items: members add own" on public.food_list_items for insert
  with check (added_by = auth.uid() and public.is_list_member(list_id)
              and exists (select 1 from public.menu_items m where m.id = menu_item_id and m.status = 'approved'));
drop policy if exists "list items: remove own" on public.food_list_items;
create policy "list items: remove own" on public.food_list_items for delete using (added_by = auth.uid());

create or replace function public.create_food_list(p_name text)
returns public.food_lists
language plpgsql security definer set search_path = public as $$
declare v public.food_lists; v_code text;
begin
  if auth.uid() is null then raise exception 'Please sign in.'; end if;
  if coalesce(char_length(trim(p_name)), 0) = 0 then raise exception 'Please give the list a name.'; end if;
  if (select count(*) from public.food_lists where owner_id = auth.uid()) >= 20 then raise exception 'You can have up to 20 lists.'; end if;
  loop
    v_code := public.new_invite_code('L');
    exit when not exists (select 1 from public.food_lists where invite_code = v_code);
  end loop;
  insert into public.food_lists (name, owner_id, invite_code) values (left(trim(p_name), 60), auth.uid(), v_code) returning * into v;
  insert into public.food_list_members (list_id, user_id, display_name) values (v.id, auth.uid(), public.first_name_of(auth.uid()));
  return v;
end $$;

create or replace function public.join_food_list(p_code text)
returns public.food_lists
language plpgsql security definer set search_path = public as $$
declare v public.food_lists;
begin
  if auth.uid() is null then raise exception 'Please sign in.'; end if;
  select * into v from public.food_lists where invite_code = upper(trim(p_code));
  if not found then raise exception 'That list code doesn''t exist. Check it and try again.'; end if;
  if not public.is_list_member(v.id) then
    if (select count(*) from public.food_list_members where list_id = v.id) >= 30 then raise exception 'This list is full (30 people).'; end if;
    insert into public.food_list_members (list_id, user_id, display_name) values (v.id, auth.uid(), public.first_name_of(auth.uid()));
  end if;
  return v;
end $$;

-- ---------- Group orders ----------
create table if not exists public.group_orders (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  leader_id uuid not null references public.profiles (id) on delete cascade,
  store_id uuid not null references public.stores (id) on delete cascade,
  title text,
  status text not null default 'open' check (status in ('open', 'locked', 'placed', 'cancelled')),
  order_ids uuid[] not null default '{}',
  locked_at timestamptz,
  placed_at timestamptz,
  expires_at timestamptz not null default now() + interval '6 hours',
  created_at timestamptz not null default now()
);
create table if not exists public.group_order_members (
  group_id uuid not null references public.group_orders (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  display_name text not null,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create table if not exists public.group_order_items (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.group_orders (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  menu_item_id uuid not null references public.menu_items (id) on delete cascade,
  qty int not null default 1 check (qty between 1 and 20),
  addon_ids uuid[] not null default '{}',
  note text check (note is null or char_length(note) <= 120),
  created_at timestamptz not null default now()
);
create index if not exists group_order_members_user_idx on public.group_order_members (user_id);
create index if not exists group_order_items_group_idx on public.group_order_items (group_id);

create or replace function public.is_group_member(p_group uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.group_order_members where group_id = p_group and user_id = auth.uid())
$$;
create or replace function public.group_is_open(p_group uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.group_orders where id = p_group and status = 'open' and expires_at > now())
$$;

alter table public.group_orders enable row level security;
alter table public.group_order_members enable row level security;
alter table public.group_order_items enable row level security;
drop policy if exists "group orders: members read" on public.group_orders;
create policy "group orders: members read" on public.group_orders for select using (public.is_group_member(id));
drop policy if exists "group members: members read" on public.group_order_members;
create policy "group members: members read" on public.group_order_members for select using (public.is_group_member(group_id));
drop policy if exists "group members: leave while open" on public.group_order_members;
create policy "group members: leave while open" on public.group_order_members for delete
  using (user_id = auth.uid() and public.group_is_open(group_id)
         and not exists (select 1 from public.group_orders g where g.id = group_id and g.leader_id = auth.uid()));
drop policy if exists "group items: members read" on public.group_order_items;
create policy "group items: members read" on public.group_order_items for select using (public.is_group_member(group_id));
drop policy if exists "group items: add own while open" on public.group_order_items;
create policy "group items: add own while open" on public.group_order_items for insert
  with check (user_id = auth.uid() and public.is_group_member(group_id) and public.group_is_open(group_id)
              and exists (select 1 from public.menu_items m join public.group_orders g on g.id = group_id
                          where m.id = menu_item_id and m.store_id = g.store_id and m.status = 'approved'));
drop policy if exists "group items: change own while open" on public.group_order_items;
create policy "group items: change own while open" on public.group_order_items for update
  using (user_id = auth.uid() and public.group_is_open(group_id))
  with check (user_id = auth.uid() and public.group_is_open(group_id));
drop policy if exists "group items: remove own while open" on public.group_order_items;
create policy "group items: remove own while open" on public.group_order_items for delete
  using (user_id = auth.uid() and public.group_is_open(group_id));

create or replace function public.create_group_order(p_store_id uuid, p_title text default null)
returns public.group_orders
language plpgsql security definer set search_path = public as $$
declare v public.group_orders; v_code text;
begin
  if auth.uid() is null then raise exception 'Please sign in.'; end if;
  if not exists (select 1 from public.stores where id = p_store_id and status = 'approved' and is_published) then
    raise exception 'That shop isn''t available.';
  end if;
  if (select count(*) from public.group_orders where leader_id = auth.uid() and status in ('open', 'locked') and expires_at > now()) >= 3 then
    raise exception 'You already have 3 group orders going. Finish or cancel one first.';
  end if;
  loop
    v_code := public.new_invite_code('G');
    exit when not exists (select 1 from public.group_orders where code = v_code);
  end loop;
  insert into public.group_orders (code, leader_id, store_id, title) values (v_code, auth.uid(), p_store_id, nullif(left(trim(coalesce(p_title, '')), 60), ''))
  returning * into v;
  insert into public.group_order_members (group_id, user_id, display_name) values (v.id, auth.uid(), public.first_name_of(auth.uid()));
  return v;
end $$;

create or replace function public.join_group_order(p_code text)
returns public.group_orders
language plpgsql security definer set search_path = public as $$
declare v public.group_orders;
begin
  if auth.uid() is null then raise exception 'Please sign in.'; end if;
  select * into v from public.group_orders where code = upper(trim(p_code));
  if not found then raise exception 'That group code doesn''t exist. Check it and try again.'; end if;
  if public.is_group_member(v.id) then return v; end if;
  if v.status <> 'open' or v.expires_at <= now() then raise exception 'This group order is closed. Ask the leader to start a new one.'; end if;
  if (select count(*) from public.group_order_members where group_id = v.id) >= 15 then raise exception 'This group is full (15 people).'; end if;
  insert into public.group_order_members (group_id, user_id, display_name) values (v.id, auth.uid(), public.first_name_of(auth.uid()));
  return v;
end $$;

-- Leader only. lock = stop changes so checkout matches exactly what everyone added;
-- unlock = reopen (e.g. someone forgot something); cancel = end it.
create or replace function public.set_group_order_state(p_group uuid, p_action text)
returns public.group_orders
language plpgsql security definer set search_path = public as $$
declare v public.group_orders;
begin
  select * into v from public.group_orders where id = p_group for update;
  if not found then raise exception 'Group order not found.'; end if;
  if v.leader_id is distinct from auth.uid() then raise exception 'Only the group leader can do this.'; end if;
  if v.status = 'placed' then raise exception 'This group order has already been placed.'; end if;
  if p_action = 'lock' then
    if v.status = 'locked' then return v; end if;
    if not exists (select 1 from public.group_order_items where group_id = p_group) then raise exception 'Nobody has added any food yet.'; end if;
    update public.group_orders set status = 'locked', locked_at = now() where id = p_group returning * into v;
  elsif p_action = 'unlock' then
    update public.group_orders set status = 'open', locked_at = null, expires_at = greatest(expires_at, now() + interval '1 hour') where id = p_group returning * into v;
  elsif p_action = 'cancel' then
    update public.group_orders set status = 'cancelled' where id = p_group returning * into v;
  else
    raise exception 'Unknown action.';
  end if;
  return v;
end $$;

-- After the leader's checkout: find the order(s) the leader placed for this
-- group (its code is on every line) and mark the group placed. Safe to call
-- any number of times; the client never sends order ids itself.
create or replace function public.attach_group_order(p_group uuid)
returns public.group_orders
language plpgsql security definer set search_path = public as $$
declare v public.group_orders; v_ids uuid[];
begin
  select * into v from public.group_orders where id = p_group for update;
  if not found or v.leader_id is distinct from auth.uid() then raise exception 'Group order not found.'; end if;
  if v.status = 'placed' then return v; end if;
  if v.status <> 'locked' then return v; end if;
  select array_agg(o.id order by o.created_at) into v_ids
    from public.orders o
   where o.customer_id = v.leader_id and o.store_id = v.store_id and o.created_at >= v.locked_at
     and exists (select 1 from jsonb_array_elements(o.items) e where e->>'specialInstructions' like '%' || v.code || '%');
  if v_ids is null then return v; end if;
  update public.group_orders set status = 'placed', placed_at = now(), order_ids = v_ids where id = p_group returning * into v;
  return v;
end $$;

revoke all on function public.create_food_list(text) from public, anon;
revoke all on function public.join_food_list(text) from public, anon;
revoke all on function public.create_group_order(uuid, text) from public, anon;
revoke all on function public.join_group_order(text) from public, anon;
revoke all on function public.set_group_order_state(uuid, text) from public, anon;
revoke all on function public.attach_group_order(uuid) from public, anon;
revoke all on function public.month_spend(uuid, date) from public, anon, authenticated;
grant execute on function public.create_food_list(text) to authenticated;
grant execute on function public.join_food_list(text) to authenticated;
grant execute on function public.create_group_order(uuid, text) to authenticated;
grant execute on function public.join_group_order(text) to authenticated;
grant execute on function public.set_group_order_state(uuid, text) to authenticated;
grant execute on function public.attach_group_order(uuid) to authenticated;
