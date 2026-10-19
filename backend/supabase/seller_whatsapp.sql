-- ============================================================
-- ClickFood: student sellers change their WhatsApp number any time (2026-10-13)
-- Runs after student_sellers.sql.
--
-- The number is never copied onto orders: buyers look it up when they tap
-- "Message the seller" (seller_contact), so a new number is used at once,
-- old orders included. update_seller_whatsapp changes only the number.
-- seller_contact also works for a buyer who has an order with the shop,
-- even if the shop is no longer listed. Safe to run more than once.
-- ============================================================

create or replace function public.update_seller_whatsapp(p_whatsapp text)
returns public.seller_profiles
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.current_seller_store_id();
  v_wa text := public.normalize_sa_whatsapp(p_whatsapp);
  sp public.seller_profiles;
begin
  if v_store is null then raise exception 'You don''t have a student shop.' using errcode = 'P0001'; end if;
  if v_wa is null then raise exception 'Please enter a valid South African WhatsApp number.' using errcode = 'P0001'; end if;
  update public.seller_profiles set whatsapp = v_wa, updated_at = now()
   where store_id = v_store returning * into sp;
  return sp;
end $$;
revoke all on function public.update_seller_whatsapp(text) from public, anon;
grant execute on function public.update_seller_whatsapp(text) to authenticated;

create or replace function public.seller_contact(p_store_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select sp.whatsapp from public.seller_profiles sp
    join public.stores s on s.id = sp.store_id
   where sp.store_id = p_store_id and auth.uid() is not null
     and s.seller_kind = 'student'
     and ((s.status = 'approved' and s.is_published)
          or (s.status <> 'archived' and exists (select 1 from public.orders o where o.store_id = p_store_id and o.customer_id = auth.uid())))
$$;
revoke all on function public.seller_contact(uuid) from public, anon;
grant execute on function public.seller_contact(uuid) to authenticated;
