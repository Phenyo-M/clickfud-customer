// LOCAL ONLY load test: bursts of simultaneous orders against a copy of the
// live ClickFood structure (built by build-db.cjs), through PostgREST with
// real per-student login tokens, so every security rule and trigger runs.
const { execFileSync, spawn } = require('child_process');
const path = require('path'); const crypto = require('crypto'); const fs = require('fs');
const { build, BIN, LT } = require('./build-db.cjs');
const PG = 55461, PGRST = 3361, POOL = Number(process.env.POOL || 15);
const DATA = path.join(LT, 'cfload2');
const JWT_SECRET = 'local-load-secret-not-used-anywhere-else-0123456789abcdef';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ exp: Math.floor(Date.now() / 1000) + 7200, ...c }); return `${h}.${p}.${crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const SERVICE = jwt({ role: 'service_role' });
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]); };
let proc;

(async () => {
  const db = await build(PG, DATA);
  if (process.env.FIX) { await db.query(fs.readFileSync(process.env.FIX, 'utf8')); console.log('applied', path.basename(process.env.FIX)); }
  try {
    // ---------- seed: one open shop, 20 items, 400 students ----------
    const store = (await db.query(`insert into stores (address, name, opening_time, closing_time, status, is_published) values ('Hatfield', 'Load Test Kitchen', '00:00', '23:59', 'approved', true) returning id`)).rows[0].id;
    const items = [];
    for (let i = 0; i < 20; i++) items.push((await db.query(`insert into menu_items (name, category, price, available, stock, store_id, status, platform_fee_amount, image) values ($1, 'Lunch', $2, true, 100000, $3, 'approved', 2, 'https://x/y.webp') returning id, price`, ['Item ' + i, 30 + i, store])).rows[0]);
    const students = [];
    for (let i = 0; i < 400; i++) {
      const id = crypto.randomUUID();
      await db.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id, `s${i}@tuks.co.za`]);
      await db.query(`insert into profiles (id, name, email, role, active, phone, student_number, university, campus_location) values ($1, $2, $3, 'customer', true, '0712345678', $4, 'University of Pretoria', 'Hatfield') on conflict (id) do update set role = 'customer', active = true`, [id, 'Student ' + i, `s${i}@tuks.co.za`, 'u' + String(10000000 + i)]);
      students.push(id);
    }
    await db.query(`notify pgrst, 'reload schema'`);

    fs.writeFileSync(path.join(__dirname, 'pgrst-load.conf'), `db-uri = "postgres://authenticator:authpw@127.0.0.1:${PG}/postgres"\ndb-schemas = "public"\ndb-anon-role = "anon"\njwt-secret = "${JWT_SECRET}"\nserver-port = ${PGRST}\ndb-pool = ${POOL}\nlog-level = "error"\n`);
    proc = spawn(path.join(LT, 'postgrest/postgrest.exe'), [path.join(__dirname, 'pgrst-load.conf')], { env: { ...process.env, PATH: BIN + ';' + process.env.PATH } });
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PGRST}/`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }

    const orderBody = (uid, picks) => {
      const its = picks.map((it) => ({ menuItemId: it.id, name: 'x', price: Number(it.price) + 2, qty: 1, image: '', addons: [], specialInstructions: '', isAddon: false }));
      const sub = its.reduce((s, x) => s + x.price, 0);
      return { customer_id: uid, store_id: store, items: its, subtotal: sub, delivery_fee: 0, discount: 0, total: sub, payment_method: 'cod', payment_status: 'pending',
        delivery_location: { fulfilment: 'collection', collection_time: new Date(Date.now() + 3600e3).toISOString() }, status: 'preparing',
        status_history: [{ status: 'received', at: new Date().toISOString() }, { status: 'preparing', at: new Date().toISOString() }], client_request_id: crypto.randomUUID() };
    };
    const place = async (uid, picks) => {
      const t = Date.now();
      try {
        const r = await fetch(`http://127.0.0.1:${PGRST}/orders`, { method: 'POST', headers: { Authorization: `Bearer ${jwt({ sub: uid, role: 'authenticated' })}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(orderBody(uid, picks)) });
        const ok = r.status === 201; const txt = ok ? '' : await r.text();
        return { ms: Date.now() - t, ok, err: ok ? null : `${r.status} ${txt.slice(0, 120)}` };
      } catch (e) { return { ms: Date.now() - t, ok: false, err: String(e).slice(0, 120) }; }
    };
    const report = (name, res) => {
      const ok = res.filter((x) => x.ok).length, ms = res.map((x) => x.ms);
      const errs = {}; res.filter((x) => !x.ok).forEach((x) => { errs[x.err] = (errs[x.err] || 0) + 1; });
      console.log(`${name}: ${ok}/${res.length} ok | median ${pct(ms, 50)} ms, p95 ${pct(ms, 95)} ms, slowest ${Math.max(...ms)} ms${Object.keys(errs).length ? ' | errors: ' + JSON.stringify(errs) : ''}`);
      return ok;
    };
    const stockSum = async () => Number((await db.query(`select sum(stock) s from menu_items where store_id = $1`, [store])).rows[0].s);

    // warm-up (first requests open connections)
    await Promise.all(students.slice(380, 390).map((u) => place(u, [items[0]])));
    const ordersBefore = Number((await db.query('select count(*) c from orders')).rows[0].c);

    // ---------- A: 200 students order at once, 2 items each, spread over the menu ----------
    let s0 = await stockSum();
    const A = await Promise.all(students.slice(0, 200).map((u, i) => place(u, [items[i % 20], items[(i * 7 + 3) % 20]])));
    const okA = report(`A  200 simultaneous cash orders (pool ${POOL})`, A);
    let s1 = await stockSum();
    const countA = Number((await db.query('select count(*) c from orders')).rows[0].c) - ordersBefore;
    console.log(`   orders saved: ${countA} (expected ${okA}); stock went down by ${s0 - s1} (expected ${okA * 2}); all unpaid cash: ${(await db.query(`select bool_and(payment_method='cod' and payment_status='pending') b from orders`)).rows[0].b}`);

    // ---------- B: worst case, 200 students order the SAME item at once ----------
    s0 = await stockSum();
    const B = await Promise.all(students.slice(200, 400).map((u) => place(u, [items[5]])));
    const okB = report('B  200 simultaneous orders of ONE item (stock contention)', B);
    s1 = await stockSum();
    console.log(`   stock went down by ${s0 - s1} (expected ${okB}); negative stock rows: ${(await db.query('select count(*) c from menu_items where stock < 0')).rows[0].c}`);

    // ---------- C: 200 PayFast payments confirmed at once (+ a duplicate each) ----------
    const refs = [];
    for (let i = 0; i < 200; i++) {
      const ref = 'cf_load' + i;
      const g = [{ storeId: store, items: [{ menuItemId: items[i % 20].id, name: 'x', price: Number(items[i % 20].price) + 2, qty: 1, addons: [], isAddon: false }], subtotal: Number(items[i % 20].price) + 2, platformFee: 2, discount: 0, total: Number(items[i % 20].price) + 2, deliveryLocation: { fulfilment: 'collection' }, subaccountCode: null, shopAmount: Number(items[i % 20].price), platformFeeAmount: 2 }];
      await db.query(`insert into checkout_sessions (reference, customer_id, email, currency, amount, groups, status, provider, environment) values ($1, $2, 'x@tuks.co.za', 'ZAR', $3, $4, 'pending', 'payfast', 'sandbox')`, [ref, students[i], g[0].total, JSON.stringify(g)]);
      refs.push([ref, g[0].total]);
    }
    const confirm = async ([ref, amt], pf) => {
      const t = Date.now();
      const r = await fetch(`http://127.0.0.1:${PGRST}/rpc/apply_payfast_payment`, { method: 'POST', headers: { Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_reference: ref, p_pf_payment_id: pf, p_amount: amt, p_environment: 'sandbox' }) });
      const j = await r.json().catch(() => ({}));
      return { ms: Date.now() - t, ok: r.ok && !j.error && !j.message, err: r.ok ? (j.error || null) : `${r.status} ${(j.message || '').slice(0, 100)}` };
    };
    const C = await Promise.all(refs.flatMap((x, i) => [confirm(x, 'pf' + i), confirm(x, 'pf' + i)]));
    report('C  200 card payments confirmed at once, each notification sent twice', C);
    const cardOrders = Number((await db.query(`select count(*) c from orders where payment_method='card' and payment_reference like 'cf_load%'`)).rows[0].c);
    const dupRefs = Number((await db.query(`select count(*) c from (select payment_reference from orders where payment_reference like 'cf_load%' group by 1 having count(*) > 1) x`)).rows[0].c);
    console.log(`   card orders created: ${cardOrders} (expected 200); payments with more than one order: ${dupRefs}; sessions still pending: ${(await db.query(`select count(*) c from checkout_sessions where reference like 'cf_load%' and status <> 'paid'`)).rows[0].c}`);

    // ---------- D: sell-out, only 50 left, 200 students try at once ----------
    await db.query('update menu_items set stock = 50, available = true where id = $1', [items[9].id]);
    const D = await Promise.all(students.slice(0, 200).map((u) => place(u, [items[9]])));
    const okD = report('D  200 students, only 50 left', D);
    const left = (await db.query('select stock, available from menu_items where id = $1', [items[9].id])).rows[0];
    console.log();

    const dl = (await db.query(`select deadlocks from pg_stat_database where datname = 'postgres'`)).rows[0].deadlocks;
    console.log(`deadlocks during the whole test: ${dl}`);
  } finally {
    if (proc) { try { execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
    await db.end().catch(() => {});
    try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DATA, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch {}
  }
})().catch((e) => { console.error('ERROR', e); if (proc) try { execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} try { execFileSync(path.join(BIN, 'pg_ctl.exe'), ['-D', DATA, 'stop', '-m', 'fast'], { stdio: 'ignore' }); } catch {} process.exit(1); });
