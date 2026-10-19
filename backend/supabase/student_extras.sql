-- ============================================================
-- ClickFood: extras for student sellers (2026-10-13)
-- Runs after student_sellers.sql.
--
-- Student sellers can create extras for their own shop (e.g. "Extra
-- cheese +R5") and choose which of their foods offer each one, using the
-- same item_extras / item_extra_links tables campus shops use. Buyers see
-- them on the food and the order total is re-priced from the database
-- (validate_order_pricing), so a wrong price can't be sent from the app.
-- Food only, R0 to R200. Safe to run more than once.
-- ============================================================

drop policy if exists "item_extras student seller write" on public.item_extras;
create policy "item_extras student seller write" on public.item_extras for all
  using (public."current_role"() = 'customer' and store_id = public.current_seller_store_id())
  with check (public."current_role"() = 'customer' and store_id = public.current_seller_store_id());

drop policy if exists "item_extra_links student seller write" on public.item_extra_links;
create policy "item_extra_links student seller write" on public.item_extra_links for all
  using (public."current_role"() = 'customer'
         and exists (select 1 from public.menu_items mi where mi.id = item_extra_links.menu_item_id and mi.store_id = public.current_seller_store_id()))
  with check (public."current_role"() = 'customer'
         and exists (select 1 from public.menu_items mi where mi.id = item_extra_links.menu_item_id and mi.store_id = public.current_seller_store_id())
         and exists (select 1 from public.item_extras ie where ie.id = item_extra_links.item_extra_id and ie.store_id = public.current_seller_store_id()));

create or replace function public.enforce_student_extra()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_word text;
begin
  if not public.is_student_store(new.store_id) then return new; end if;
  new.name := btrim(coalesce(new.name, ''));
  if length(new.name) < 2 or length(new.name) > 40 then raise exception 'Please name the extra (2 to 40 characters).' using errcode = 'P0001'; end if;
  if new.price is null or new.price < 0 or new.price > 200 then raise exception 'Extras cost between R0 and R200.' using errcode = 'P0001'; end if;
  v_word := coalesce(public.non_food_word(new.name), public.alcohol_word(new.name), public.non_food_word(new.description));
  if v_word is not null then
    raise exception 'Only food can be sold on ClickFood ("%" isn''t allowed).', v_word using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_enforce_student_extra on public.item_extras;
create trigger trg_enforce_student_extra before insert or update on public.item_extras
  for each row execute function public.enforce_student_extra();
