insert into public.stores (name, description, category, campus_location, cover_image_url, logo_url, delivery_fee, prep_time_min, prep_time_max, rating, rating_count)
select v.name, v.description, v.category, v.campus_location, v.cover_image_url, v.logo_url, v.delivery_fee, v.prep_time_min, v.prep_time_max, v.rating, v.rating_count
from (values
  ('Campus Grill', 'Burgers, chicken and hearty campus favourites.', 'Fast Food', 'South Campus', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=1200&q=60', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=200&q=60', 10.00, 15, 25, 4.6, 0),
  ('Kota Republic', 'Durban-style bunny chow, kotas and local favourites.', 'Local Food', 'Student Centre', 'https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?auto=format&fit=crop&w=1200&q=60', 'https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?auto=format&fit=crop&w=200&q=60', 8.00, 15, 25, 4.7, 0),
  ('Brew & Bake', 'Coffee, breakfast and fresh-baked treats.', 'Coffee & Bakery', 'Library', 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=1200&q=60', 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=200&q=60', 6.00, 8, 15, 4.5, 0)
) as v(name, description, category, campus_location, cover_image_url, logo_url, delivery_fee, prep_time_min, prep_time_max, rating, rating_count)
where not exists (select 1 from public.stores s where s.name = v.name);

insert into public.store_promotions (store_id, title, message, badge, image_url, promo_type, active, priority)
select st.id, v.title, v.message, v.badge, v.image_url, v.promo_type, v.active, v.priority
from (values
  ('Kota Republic', 'New Kota Flavours', 'Bigger. Juicier. Better.', 'New Menu', 'https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?auto=format&fit=crop&w=1000&q=60', 'new_menu', true, 2),
  ('Brew & Bake', 'Iced Coffee Deal', 'R25 instead of R35, all week.', 'Special Offer', 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=1000&q=60', 'special_offer', true, 1),
  ('Campus Grill', 'Meal Deal Monday', 'Burger, chips and a drink — one low price.', 'Meal Deal', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=1000&q=60', 'discount', true, 0)
) as v(store_name, title, message, badge, image_url, promo_type, active, priority)
join public.stores st on st.name = v.store_name
where not exists (
  select 1 from public.store_promotions sp where sp.store_id = st.id and sp.title = v.title
);

update public.menu_items set store_id = (select id from public.stores where name = 'Campus Grill')
  where name in ('Beef Burger & Chips','Chicken Burger & Chips','Margherita Pizza','Chicken & Chips','Grilled Chicken Wrap','Beef Lasagne') and store_id is null;

update public.menu_items set store_id = (select id from public.stores where name = 'Kota Republic')
  where name in ('Beef Bunny Chow','Vegetable Samosas (4)') and store_id is null;

update public.menu_items set store_id = (select id from public.stores where name = 'Brew & Bake')
  where name in ('Full English Breakfast','Bacon & Egg Roll','Chocolate Muffin','Chocolate Brownie','Vanilla Milkshake','Cold Drink 330ml') and store_id is null;

insert into public.menu_items (name, category, price, image, description, ingredients, allergens, preparation_time, available, stock, rating, rating_count, store_id)
select v.name, v.category, v.price, v.image, v.description, v.ingredients, v.allergens, v.preparation_time, v.available, v.stock, v.rating, v.rating_count, st.id
from (values
  ('Classic Kota', 'Specials', 40.00, 'https://images.unsplash.com/photo-1626700051175-6818013e1d4f?auto=format&fit=crop&w=800&q=60', 'Hollowed-out quarter loaf with polony, chips, cheese and atchar.', array['Bread','Polony','Chips','Cheese','Atchar'], array['Gluten','Dairy'], 15, true, 30, 4.6, 0, 'Kota Republic'),
  ('Kota with Russian', 'Specials', 48.00, 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=800&q=60', 'Classic kota loaded with a russian sausage, chips and sauce.', array['Bread','Russian Sausage','Chips','Sauce'], array['Gluten'], 15, true, 25, 4.7, 0, 'Kota Republic')
) as v(name, category, price, image, description, ingredients, allergens, preparation_time, available, stock, rating, rating_count, store_name)
join public.stores st on st.name = v.store_name
where not exists (select 1 from public.menu_items m where m.name = v.name);
