// Synthetic campus data for load tests (never real people): shops, menus,
// students, past orders and reviews. Inserted with triggers off (replica
// mode), so it is quick; any required column not given here is filled with
// a plain value of the right type.
const crypto = require('crypto');

async function requiredCols(q, table) {
  return (await q(`select column_name c, data_type t, udt_name u from information_schema.columns
                   where table_schema = 'public' and table_name = $1 and is_nullable = 'NO' and column_default is null and is_identity = 'NO' and is_generated = 'NEVER'`, [table])).rows;
}
async function checkValues(q, table, col) {
  // first allowed value from a CHECK (col in (...)) / = ANY (ARRAY[...]) constraint, if any
  const r = (await q(`select pg_get_constraintdef(c.oid) d from pg_constraint c join pg_class t on t.oid = c.conrelid
                      where t.relname = $1 and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%' || $2 || '%'`, [table, col])).rows;
  for (const x of r) { const m = x.d.match(/'([^']+)'::text/); if (m) return m[1]; }
  return null;
}
function filler(t, u) {
  if (/uuid/.test(u)) return crypto.randomUUID();
  if (/int|numeric|double|real/.test(u)) return 0;
  if (/bool/.test(u)) return false;
  if (/timestamp|date/.test(t)) return new Date().toISOString();
  if (/json/.test(u)) return '{}';
  if (u.startsWith('_')) return '{}';
  return 'x';
}
async function insertRows(q, table, rows) {
  if (!rows.length) return;
  const req = await requiredCols(q, table);
  const extra = [];
  for (const c of req) if (!(c.c in rows[0])) extra.push([c.c, (await checkValues(q, table, c.c)) ?? filler(c.t, c.u)]);
  const cols = [...Object.keys(rows[0]), ...extra.map(e => e[0])];
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500); const params = []; const vals = [];
    for (const r of chunk) {
      const ph = cols.map((c) => { const v = c in r ? r[c] : extra.find(e => e[0] === c)[1]; params.push(v); return '$' + params.length; });
      vals.push('(' + ph.join(',') + ')');
    }
    await q(`insert into ${table} (${cols.join(',')}) values ${vals.join(',')}`, params);
  }
}

async function seedApp(q, opts) {
  const o = Object.assign({ stores: 40, itemsPerStore: 25, students: 2000, orders: 20000, reviews: 3000 }, opts || {});
  await q(`set session_replication_role = replica`);
  const mgr = crypto.randomUUID();
  await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, 'loadmgr@shop.test', now())`, [mgr]);
  await q(`insert into profiles (id, name, email, role, status, active) values ($1, 'Load Manager', 'loadmgr@shop.test', 'manager', 'approved', true)`, [mgr]);
  const stores = []; const items = [];
  for (let s = 0; s < o.stores; s++) {
    const id = crypto.randomUUID(); stores.push(id);
    await q(`insert into stores (id, manager_id, name, slug, category, campus_location, address, university, status, is_published, opening_time, closing_time)
             values ($1, $2, $3, $4, 'Fast Food', 'Hatfield', 'Hatfield', 'University of Pretoria', 'approved', true, '00:00', '23:59')`, [id, mgr, 'Load Shop ' + s, 'load-shop-' + s]);
    const rows = [];
    for (let i = 0; i < o.itemsPerStore; i++) { const iid = crypto.randomUUID(); items.push({ id: iid, store: id }); rows.push({ id: iid, store_id: id, name: `Shop ${s} item ${i}`, category: i % 2 ? 'Lunch' : 'Drinks', price: 20 + i, image: 'https://x/y.webp', description: 'Synthetic item', status: 'approved', available: true, stock: 100000 }); }
    await insertRows(q, 'menu_items', rows);
  }
  const students = [];
  const urows = [], prows = [];
  for (let i = 0; i < o.students; i++) {
    const id = crypto.randomUUID(); const email = `u7${String(i).padStart(7, '0')}@tuks.co.za`; students.push({ id, email });
    urows.push({ id, email, email_confirmed_at: new Date().toISOString() });
    prows.push({ id, name: 'Student ' + i, email, role: 'customer', status: 'approved', active: true, university: 'University of Pretoria', campus_location: 'Hatfield', student_number: 'u7' + String(i).padStart(7, '0') });
  }
  for (let i = 0; i < urows.length; i += 500) {
    const ch = urows.slice(i, i + 500); const p = []; const v = ch.map(r => { p.push(r.id, r.email, r.email_confirmed_at); return `($${p.length - 2},$${p.length - 1},$${p.length})`; });
    await q(`insert into auth.users (id, email, email_confirmed_at) values ${v.join(',')}`, p);
  }
  await insertRows(q, 'profiles', prows);
  const orows = [];
  for (let i = 0; i < o.orders; i++) {
    const st = students[i % students.length]; const it = items[(i * 7) % items.length];
    orows.push({ customer_id: st.id, store_id: it.store, status: i % 10 ? 'collected' : 'received', total: 45, created_at: new Date(Date.now() - (i % 720) * 3600000).toISOString(),
      items: JSON.stringify([{ id: it.id, name: 'Synthetic', qty: 1, price: 45 }]) });
  }
  await insertRows(q, 'orders', orows);
  await q(`set session_replication_role = origin`);
  await q(`analyze`);
  return { stores, items, students };
}

module.exports = { seedApp, insertRows };
