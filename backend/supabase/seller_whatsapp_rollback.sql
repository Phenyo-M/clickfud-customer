-- Undo seller_whatsapp.sql (seller_contact back to live shops only)
drop function if exists public.update_seller_whatsapp(text);
create or replace function public.seller_contact(p_store_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select sp.whatsapp from public.seller_profiles sp
    join public.stores s on s.id = sp.store_id
   where sp.store_id = p_store_id and auth.uid() is not null
     and s.seller_kind = 'student' and s.status = 'approved' and s.is_published
$$;
revoke all on function public.seller_contact(uuid) from public, anon;
grant execute on function public.seller_contact(uuid) to authenticated;
