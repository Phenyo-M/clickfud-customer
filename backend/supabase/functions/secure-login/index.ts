// ============================================================
// CLICKFOOD — secure-login Edge Function
//
// Password sign-in for all three apps, with login protection
// (supabase/login_protection.sql). Before Supabase Auth is asked, one
// database call (login_guard) checks every limit at once and atomically:
// email + network, email from any network, one network, floods, and
// requests still in flight (so parallel requests can't buy extra guesses).
// After the answer, login_record counts the result. Waits grow 30 s, 1, 2,
// 4, 8 min, never more than 15 min, and never block a student on a network
// they signed in from before because someone else is guessing their
// password elsewhere. Nothing is locked permanently.
//
// Privacy: the database only ever sees keyed hashes (HMAC) of the email and
// the network address, never the values themselves.
//
// Network address: ONLY Cloudflare's cf-connecting-ip (Cloudflare sits in
// front of Supabase and overwrites it). X-Forwarded-For is NOT used: its
// first entry can be typed in by anyone. If the header is missing, the
// network limits are skipped (counted as "no_ip" in the metrics so it shows
// in the developer dashboard) and the email limits still apply.
//
// If the database counters can't be reached, a stricter limiter inside this
// instance takes over (never "no limits", never "nobody can log in"), and the
// outage is counted and reported once the database answers again.
//
// Same wording for unknown and real accounts at every step, so nothing here
// tells anyone whether an email has an account.
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const IP_HEADER = (Deno.env.get("LOGIN_IP_HEADER") || "cf-connecting-ip").toLowerCase();
const GUARD_TIMEOUT_MS = 2000;

// This ONE deployed function is shared by all three ClickFood frontends,
// each sending its own `app`. It only narrows which of an account's OWN
// roles may sign in here; it can never grant a role.
const ROLES_BY_APP: Record<string, string[]> = {
  customer: ["customer"],
  staff: ["manager", "kitchen", "driver", "dispatcher"],
  developer: ["developer"],
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ---------- identifiers ----------
// Same person, same key: case, spaces, look-alike Unicode forms, "+tags",
// a trailing dot, and Gmail's ignored dots all map to one identifier.
export function normalizeEmail(raw: unknown): string {
  let e = String(raw ?? "").normalize("NFKC").replace(/[​-‍﻿\s]/g, "").toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1).replace(/\.+$/, "");
  local = local.split("+")[0];
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return local + "@" + domain;
}

export function clientIp(req: Request): string | null {
  const v = (req.headers.get(IP_HEADER) || "").trim();
  return /^[0-9a-fA-F:.]{3,45}$/.test(v) ? v.toLowerCase() : null;
}

let hmacKey: CryptoKey | null = null;
async function hash(s: string): Promise<string> {
  if (!hmacKey) {
    const secret = Deno.env.get("LOGIN_HASH_KEY") || ("clickfood-login-v1:" + serviceRoleKey);
    hmacKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }
  const sig = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(s));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// ---------- fallback limiter (this instance only, stricter) ----------
const local = new Map<string, number[]>();
let storeErrors = 0;
function recent(key: string, windowMs: number): number[] {
  const now = Date.now();
  const list = (local.get(key) || []).filter((t) => t > now - windowMs);
  local.set(key, list);
  if (local.size > 20000) local.clear();   // memory guard
  return list;
}
function localGuard(acct: string, ip: string | null, pair: string): number | null {
  if (ip) {
    const a = recent("ia:" + ip, 5 * 60000);
    if (a.length >= 60) return 60;
    a.push(Date.now());
  }
  if (recent("pf:" + pair, 15 * 60000).length >= 5) return 300;
  if (recent("af:" + acct, 15 * 60000).length >= 10) return 300;
  return null;
}
function localFail(acct: string, pair: string) {
  recent("pf:" + pair, 15 * 60000).push(Date.now());
  recent("af:" + acct, 15 * 60000).push(Date.now());
}

// ---------- robot check (Cloudflare Turnstile) ----------
// Supabase Auth does not check CAPTCHA on this server's own sign-in calls (they
// use the server key), so the token from the app is checked here, with
// Cloudflare. Needs the secret in TURNSTILE_SECRET_KEY (Edge Function
// secrets). Without it the check is skipped, as before. If Cloudflare can't be
// reached the login carries on (logged); the login limits still apply.
const TURNSTILE_SECRET = Deno.env.get('TURNSTILE_SECRET_KEY') || '';
const TURNSTILE_URL = Deno.env.get('TURNSTILE_VERIFY_URL') || 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
async function robotCheck(token: unknown, ip: string | null): Promise<'ok' | 'skip' | 'fail'> {
  if (!TURNSTILE_SECRET) return 'skip';
  const t = typeof token === 'string' ? token.slice(0, 2048) : '';
  if (!t) return 'fail';
  try {
    const form = new URLSearchParams({ secret: TURNSTILE_SECRET, response: t });
    if (ip) form.set('remoteip', ip);
    const res = await fetch(TURNSTILE_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(5000) });
    const j = await res.json().catch(() => ({}));
    return j && j.success === true ? 'ok' : 'fail';
  } catch (e) {
    console.error('Turnstile unreachable, login allowed:', String(e).slice(0, 120));
    return 'skip';
  }
}

function waitMessage(seconds: number): string {
  const m = Math.ceil(seconds / 60);
  return seconds < 60 ? `Too many attempts. Please wait ${seconds} seconds and try again.`
    : `Too many attempts. Please wait ${m} ${m === 1 ? "minute" : "minutes"} and try again.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const started = Date.now();

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "Email and password are required." }); }
  const { email, password, app, captcha_token } = body as Record<string, string>;
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!cleanEmail || !password) return json({ error: "Email and password are required." });
  const allowedRoles = ROLES_BY_APP[String(app || "customer")] || ROLES_BY_APP.customer;
  if (await robotCheck(captcha_token, clientIp(req)) === 'fail') {
    return json({ error: 'The security check failed. Please try again.', captcha_failed: true });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  // signing in happens on its own client so the server client stays the server
  const authClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const id = normalizeEmail(cleanEmail);
  const ip = clientIp(req);
  const acctH = await hash("a:" + id);
  const ipH = ip ? await hash("i:" + ip) : null;
  const pairH = await hash("p:" + id + "|" + (ip || "noip"));

  // ---------- 1. guard ----------
  let fallback = false;
  try {
    const { data, error } = await supabase.rpc("login_guard", { p_acct: acctH, p_ip: ipH, p_pair: pairH })
      .abortSignal(AbortSignal.timeout(GUARD_TIMEOUT_MS));
    if (error || !data) throw error || new Error("no answer");
    if (data.allowed === false) {
      const retry = Math.max(1, Number(data.retry_after) || 30);
      return json({ error: waitMessage(retry), lockedUntil: new Date(Date.now() + retry * 1000).toISOString(), rate_limited: true });
    }
  } catch (e) {
    fallback = true; storeErrors++;
    console.error("login_guard unavailable, using the local limiter:", String(e).slice(0, 200));
    const retry = localGuard(acctH, ipH, pairH);
    if (retry) return json({ error: waitMessage(retry), lockedUntil: new Date(Date.now() + retry * 1000).toISOString(), rate_limited: true });
  }

  // ---------- 2. sign in, always followed by login_record ----------
  let outcome = "error" as "success" | "failure" | "auth_limited" | "error" | "other";
  try {
    const wrong = () => { outcome = "failure"; return json({ error: "Invalid login credentials" }); };

    // not an email address at all: a wrong try that never reaches Supabase Auth
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return wrong();

    const { data: authData, error: authError } = await authClient.auth.signInWithPassword({
      email: cleanEmail, password: String(password),   // robot check already done above (token is single-use)
    });
    if (authError) {
      const what = `${authError.message} ${(authError as { code?: string }).code || ""}`;
      const status = (authError as { status?: number }).status;
      if (status === 429 || /over_request_rate_limit|rate limit/i.test(what)) {
        outcome = "auth_limited";
        return json({ error: "Too many sign-ins right now. Please wait a minute and try again.", lockedUntil: new Date(Date.now() + 60000).toISOString(), rate_limited: true });
      }
      if (/invalid login credentials|invalid_credentials|validation_failed|invalid format|email_address_invalid/i.test(what)) return wrong();
      if (/captcha/i.test(what)) { outcome = "other"; return json({ error: "The security check failed. Please try again." }); }
      outcome = "other";
      return json({ error: authError.message });
    }

    // a correct password for an account that doesn't belong in THIS app is
    // answered exactly like a wrong password (never confirms the account)
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", authData.user.id).maybeSingle();
    if (profile && !allowedRoles.includes(profile.role)) return wrong();

    // (2026-10-17) customers may use any email they verified; student status
    // is proved separately (student-verify) and only for student deals

    outcome = "success";
    return json({ session: authData.session, user: authData.user });
  } catch (e) {
    console.error(e);
    outcome = "error";
    return json({ error: "Something went wrong. Please try again." }, 500);
  } finally {
    if (fallback) {
      if (outcome === "failure") localFail(acctH, pairH);
    } else {
      const flags = { store_errors: storeErrors };
      try {
        const { error } = await supabase.rpc("login_record", { p_acct: acctH, p_ip: ipH, p_pair: pairH, p_outcome: outcome, p_latency_ms: Date.now() - started, p_flags: flags })
          .abortSignal(AbortSignal.timeout(GUARD_TIMEOUT_MS));
        if (error) throw error;
        storeErrors = 0;
      } catch (e) {
        storeErrors++;
        if (outcome === "failure") localFail(acctH, pairH);
        console.error("login_record failed:", String(e).slice(0, 200));
      }
    }
  }
});
