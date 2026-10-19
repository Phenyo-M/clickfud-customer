// ClickFood: Cloudflare DNS + Email Routing helper (runs on your computer only).
//
//   Read only (default): reports the zone, its assigned nameservers, every DNS
//   record, what the live site and email need, and Email Routing status.
//     CF_API_TOKEN=... node backend/scripts/cloudflare-dns.mjs
//
//   Apply (only after you approve the plan it prints): adds MISSING records,
//   never edits or deletes anything, then asks you to type "yes".
//     CF_API_TOKEN=... node backend/scripts/cloudflare-dns.mjs --apply
//     optional: DMARC_RUA=dmarc@clickfood.co.za  (adds a DMARC record, p=none)
//
// The token is read from the environment only, never printed, never written
// to a file. Use a token limited to this one zone with:
//   Zone > DNS > Edit, Zone > Zone > Read, Zone > Email Routing Rules > Edit
//   (Email Routing settings need Zone > Zone Settings > Edit to enable).
import readline from 'node:readline/promises';

const ZONE_NAME = 'clickfood.co.za';
const API = 'https://api.cloudflare.com/client/v4';
const TOKEN = process.env.CF_API_TOKEN || '';
const APPLY = process.argv.includes('--apply');
const DMARC_RUA = (process.env.DMARC_RUA || '').trim().toLowerCase();

// What the live services use today, read from public DNS on 2026-10-17
// (Domains.co.za nameservers). Cloudflare's own import should copy these;
// they are listed so the script can confirm nothing was missed.
// proxied:false = "DNS only" (grey cloud): Vercel and Resend need that.
const KEEP = [
  { type: 'A', name: ZONE_NAME, content: '216.198.79.1', why: 'customer website on Vercel (clickfood.co.za)' },
  { type: 'CNAME', name: 'manager.' + ZONE_NAME, content: '980f328d8b5ac473.vercel-dns-017.com', why: 'manager app on Vercel' },
  { type: 'TXT', name: 'resend._domainkey.' + ZONE_NAME, content: null, why: 'Resend DKIM (app emails); copied as is, value not repeated here' },
  { type: 'CNAME', name: 'send.' + ZONE_NAME, content: 'send.forge.rmta.net', why: 'Resend sending (bounces/SPF)' },
  { type: 'CNAME', name: 'rsend.' + ZONE_NAME, content: 'rsend-euw1.forge.rmta.net', why: 'Resend sending (eu-west-1)' },
];

if (!TOKEN) { console.error('Set CF_API_TOKEN in your terminal first (it is never printed).'); process.exit(1); }
if (process.argv.some(a => a === TOKEN)) { console.error('Do not pass the token as an argument; use the CF_API_TOKEN variable.'); process.exit(1); }
const redact = (s) => String(s).split(TOKEN).join('[token]');

async function cf(path, opts = {}) {
  const res = await fetch(API + path, { ...opts, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  let j = {}; try { j = await res.json(); } catch { /* not json */ }
  if (!res.ok || j.success === false) {
    const msg = (j.errors || []).map(e => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
    const err = new Error(redact(msg)); err.status = res.status; throw err;
  }
  return j;
}
async function all(path) {
  const out = []; let page = 1;
  for (;;) {
    const j = await cf(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    out.push(...(j.result || []));
    if (!j.result_info || page >= j.result_info.total_pages) return out;
    page++;
  }
}
const same = (a, b) => String(a || '').replace(/\.$/, '').toLowerCase() === String(b || '').replace(/\.$/, '').toLowerCase();
const short = (s, n = 60) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));

(async () => {
  // ---------------- read ----------------
  const zones = (await cf(`/zones?name=${ZONE_NAME}`)).result || [];
  if (!zones.length) { console.log(`${ZONE_NAME} is not added to this Cloudflare account yet (or the token can't see it).`); return; }
  const zone = zones[0];
  console.log(`\nZone ${zone.name}: status ${zone.status}`);
  console.log('Cloudflare nameservers to set at Domains.co.za:', (zone.name_servers || []).join(', '));
  if (zone.original_name_servers) console.log('Nameservers Cloudflare saw at the registrar:', zone.original_name_servers.join(', '));

  const records = await all(`/zones/${zone.id}/dns_records`);
  console.log(`\nDNS records in Cloudflare (${records.length}):`);
  for (const r of records.sort((a, b) => (a.name + a.type).localeCompare(b.name + b.type))) {
    console.log(`  ${r.type.padEnd(5)} ${r.name.padEnd(36)} ${short(r.content).padEnd(62)} ${r.proxied ? 'proxied' : 'DNS only'}${r.priority != null ? ' prio ' + r.priority : ''}`);
  }

  console.log('\nServices that must keep working:');
  const plan = [];
  for (const k of KEEP) {
    const found = records.filter(r => r.type === k.type && same(r.name, k.name));
    const ok = found.some(r => k.content === null || same(r.content, k.content));
    const proxiedWarn = found.some(r => r.proxied);
    console.log(`  ${ok ? 'OK     ' : 'MISSING'} ${k.type} ${k.name} (${k.why})${proxiedWarn ? '  <- set to DNS only (grey cloud)' : ''}`);
    if (!ok && k.content && !found.length) plan.push({ type: k.type, name: k.name, content: k.content, proxied: false, ttl: 1, comment: 'ClickFood: ' + k.why });
    if (!ok && k.content === null) console.log('          copy this TXT value from Domains.co.za or the Resend dashboard (Domains > clickfood.co.za)');
  }

  const has = (pred) => records.some(pred);
  const rootTxt = records.filter(r => r.type === 'TXT' && same(r.name, ZONE_NAME));
  const spf = rootTxt.filter(r => /^"?v=spf1/i.test(r.content));
  console.log('\nEmail:');
  console.log('  MX on clickfood.co.za:', has(r => r.type === 'MX' && same(r.name, ZONE_NAME)) ? 'present' : 'none (no inbox receives mail yet)');
  console.log('  SPF on clickfood.co.za:', spf.length ? spf.map(r => short(r.content, 80)).join(' | ') + (spf.length > 1 ? '  <- more than one SPF record is invalid' : '') : 'none');
  console.log('  DKIM (Resend):', has(r => r.type === 'TXT' && same(r.name, 'resend._domainkey.' + ZONE_NAME)) ? 'present' : 'missing');
  console.log('  DMARC:', has(r => r.type === 'TXT' && same(r.name, '_dmarc.' + ZONE_NAME)) ? 'present' : 'missing');

  let routing = null;
  try { routing = (await cf(`/zones/${zone.id}/email/routing`)).result; console.log(`  Email Routing: ${routing.enabled ? 'enabled' : 'off'} (status ${routing.status || 'unknown'})`); }
  catch (e) { console.log('  Email Routing: could not read (' + e.message + ')'); }
  let needed = [];
  try {
    const d = (await cf(`/zones/${zone.id}/email/routing/dns`)).result;
    needed = Array.isArray(d) ? d : (d && (d.records || d.record)) || [];
    if (needed.length) {
      console.log('  Records Cloudflare says Email Routing needs:');
      for (const r of needed) console.log(`    ${r.type} ${r.name} ${short(r.content, 70)}${r.priority != null ? ' prio ' + r.priority : ''}  ${has(x => x.type === r.type && same(x.name, r.name) && same(x.content, r.content)) ? 'OK' : 'missing'}`);
    }
  } catch (e) { console.log('  Email Routing records: could not read (' + e.message + ')'); }
  try {
    const rules = (await all(`/zones/${zone.id}/email/routing/rules`));
    console.log(`  Routing rules (${rules.length}):`);
    for (const r of rules) console.log(`    ${r.enabled ? 'on ' : 'off'} ${(r.matchers || []).map(m => m.value || m.type).join(', ')} -> ${(r.actions || []).map(a => (a.value || []).join(', ') || a.type).join('; ')}`);
  } catch (e) { console.log('  Routing rules: could not read (' + e.message + ')'); }

  if (DMARC_RUA && !has(r => r.type === 'TXT' && same(r.name, '_dmarc.' + ZONE_NAME))) {
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(DMARC_RUA)) { console.error('\nDMARC_RUA is not a valid email address.'); process.exit(1); }
    plan.push({ type: 'TXT', name: '_dmarc.' + ZONE_NAME, content: `v=DMARC1; p=none; rua=mailto:${DMARC_RUA}`, ttl: 1, comment: 'ClickFood: DMARC (monitor only)' });
  }

  // ---------------- apply (only with --apply and your "yes") ----------------
  const enableRouting = routing && !routing.enabled;
  if (!APPLY) {
    console.log(`\nRead only. Nothing was changed.${plan.length || enableRouting ? ' Run again with --apply to see the change plan.' : ''}`);
    return;
  }
  if (!plan.length && !enableRouting) { console.log('\nNothing to add. Nothing was changed.'); return; }
  console.log('\nPlanned changes (nothing is edited or deleted):');
  for (const p of plan) console.log(`  ADD ${p.type} ${p.name} ${p.content} ${p.proxied === false ? '(DNS only)' : ''}`);
  if (enableRouting) console.log('  ENABLE Email Routing (Cloudflare adds its own MX + SPF + DKIM records; an existing different SPF must be merged by hand)');
  if (spf.length && enableRouting) console.log('  NOTE: an SPF record already exists; Cloudflare may refuse or you must merge "include:_spf.mx.cloudflare.net" into it by hand.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('\nType "yes" to make exactly these changes: ')).trim();
  rl.close();
  if (answer !== 'yes') { console.log('Cancelled. Nothing was changed.'); return; }
  for (const p of plan) {
    try { await cf(`/zones/${zone.id}/dns_records`, { method: 'POST', body: JSON.stringify(p) }); console.log(`  added ${p.type} ${p.name}`); }
    catch (e) { console.log(`  FAILED ${p.type} ${p.name}: ${e.message}`); }
  }
  if (enableRouting) {
    try { await cf(`/zones/${zone.id}/email/routing/enable`, { method: 'POST', body: '{}' }); console.log('  Email Routing enabled'); }
    catch (e) { console.log('  FAILED to enable Email Routing: ' + e.message + ' (you can enable it in the dashboard: Email > Email Routing)'); }
  }
  console.log('\nDone. Run without --apply to check the result.');
})().catch((e) => { console.error('Error:', redact(e.message)); process.exit(1); });
