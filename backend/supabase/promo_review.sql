-- =========================================================================
-- ClickFood: promo codes and discounts made by a shop manager are approved
-- by the developer before customers can see or use them (2026-10-18).
-- Run after engagement_deals.sql and poll_review.sql. Safe to run more than once.
--
--  * promotions.review_status: pending_review / approved / rejected.
--    A manager's new code is ALWAYS saved as pending_review (a trigger sets
--    it, so the app cannot skip the review). Changing anything about a code
--    (discount, products, dates, who can use it, Campus Deals settings)
--    sends it back for review. Switching it off or on does not.
--  * Customers only read approved codes, and checkout refuses any code that
--    isn't approved: promo_block_reason() is what cash orders (trigger
--    trg_zz_enforce_deal_rules) and card payments (create-payfast-payment)
--    both check.
--  * dev_review_promo(): developer only. Reject needs a reason, which the
--    manager sees.
--  * Codes that already exist stay approved, so live codes keep working.
-- =========================================================================

alter table public.promotions add column if not exists review_status text not null default 'approved';
alter table public.promotions alter column review_status set default 'pending_review';
do $$ begin
  alter table public.promotions add constraint promotions_review_status_valid check (review_status in ('pending_review', 'approved', 'rejected'));
exception when duplicate_object then null; end $$;
alter table public.promotions add column if not exists submitted_at timestamptz;
alter table public.promotions add column if not exists reviewed_by uuid references public.profiles (id) on delete set null;
alter table public.promotions add column if not exists reviewed_at timestamptz;
alter table public.promotions add column if not exists review_note text check (review_note is null or char_length(review_note) <= 300);
create index if not exists promotions_pending_idx on public.promotions (submitted_at) where review_status = 'pending_review';

create or replace function public.promotions_review_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;                          -- server jobs
  if tg_op = 'INSERT' then
    if public.current_role() = 'developer' then
      new.review_status := 'approved'; new.reviewed_by := auth.uid(); new.reviewed_at := now(); new.review_note := null;
    else
      new.review_status := 'pending_review'; new.reviewed_by := null; new.reviewed_at := null; new.review_note := null;
    end if;
    new.submitted_at := now();
    return new;
  end if;
  if public.current_role() = 'developer' then return new; end if;
  -- everyone else: the review result is never theirs to change
  new.review_status := old.review_status; new.reviewed_by := old.reviewed_by; new.reviewed_at := old.reviewed_at;
  new.review_note := old.review_note; new.submitted_at := old.submitted_at;
  if (new.code, new.type, new.value, new.expires_at, new.usage_limit, new.menu_item_ids, new.title, new.terms, new.starts_at,
      new.daily_start, new.daily_end, new.min_order, new.deal_tags, new.is_public, new.campaign_id, new.audience,
      new.per_customer_limit, new.university_id, new.campus_id, new.store_id)
     is distinct from
     (old.code, old.type, old.value, old.expires_at, old.usage_limit, old.menu_item_ids, old.title, old.terms, old.starts_at,
      old.daily_start, old.daily_end, old.min_order, old.deal_tags, old.is_public, old.campaign_id, old.audience,
      old.per_customer_limit, old.university_id, old.campus_id, old.store_id) then
    new.review_status := 'pending_review'; new.reviewed_by := null; new.reviewed_at := null; new.review_note := null; new.submitted_at := now();
  end if;
  return new;
end $$;
drop trigger if exists trg_promotions_review_guard on public.promotions;
create trigger trg_promotions_review_guard before insert or update on public.promotions for each row execute function public.promotions_review_guard();

-- Who reads codes: customers only approved ones. Managers still read their
-- own through "promos manager write"; the developer reads all.
drop policy if exists "promos select all" on public.promotions;
drop policy if exists "promos select approved" on public.promotions;
create policy "promos select approved" on public.promotions for select using (review_status = 'approved' or public.current_role() = 'developer');

-- Checkout: an unapproved code is never accepted (same function as before, one rule added).
create or replace function public.promo_block_reason(p_code text, p_order_subtotal numeric)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  p public.promotions;
  v_local timestamp := now() at time zone 'Africa/Johannesburg';
begin
  if p_code is null then return null; end if;
  select * into p from public.promotions where code = upper(trim(p_code));
  if not found or not p.active or p.review_status <> 'approved' then return 'This promo code is not valid.'; end if;
  if p.starts_at is not null and p.starts_at > now() then
    return 'This deal starts on ' || to_char(p.starts_at at time zone 'Africa/Johannesburg', 'DD Mon HH24:MI') || '.';
  end if;
  if p.expires_at is not null and p.expires_at < now() then return 'This promo code has expired.'; end if;
  if p.usage_limit is not null and p.used_count >= p.usage_limit then return 'This deal has been fully claimed.'; end if;
  if p.daily_start is not null and (v_local::time < p.daily_start or v_local::time >= p.daily_end) then
    return 'This deal is only on between ' || to_char(p.daily_start, 'HH24:MI') || ' and ' || to_char(p.daily_end, 'HH24:MI') || '.';
  end if;
  if p.min_order is not null and coalesce(p_order_subtotal, 0) < p.min_order then
    return 'This deal needs an order of at least R' || to_char(p.min_order, 'FM999990.00') || '.';
  end if;
  return null;
end $$;
grant execute on function public.promo_block_reason(text, numeric) to anon, authenticated, service_role;

create or replace function public.dev_review_promo(p_promo uuid, p_action text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.promotions; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if auth.uid() is null or public.current_role() <> 'developer' then return jsonb_build_object('ok', false, 'error', 'Only the developer can review promo codes.'); end if;
  select * into p from public.promotions where id = p_promo for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Promo code not found.'); end if;
  if p.review_status <> 'pending_review' then return jsonb_build_object('ok', false, 'error', 'This promo code has already been reviewed.'); end if;
  if p_action = 'approve' then
    update public.promotions set review_status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), review_note = null where id = p.id;
  elsif p_action = 'reject' then
    if v_note is null or char_length(v_note) < 3 then return jsonb_build_object('ok', false, 'error', 'Please give the shop a reason.'); end if;
    update public.promotions set review_status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_note = left(v_note, 300) where id = p.id;
  else
    return jsonb_build_object('ok', false, 'error', 'Unknown action.');
  end if;
  return jsonb_build_object('ok', true, 'status', case when p_action = 'approve' then 'approved' else 'rejected' end);
end $$;
revoke all on function public.dev_review_promo(uuid, text, text) from public, anon;
grant execute on function public.dev_review_promo(uuid, text, text) to authenticated;
