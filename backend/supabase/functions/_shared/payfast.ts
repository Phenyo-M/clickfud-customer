// ============================================================
// CLICKFOOD — PayFast helpers shared by every payment function
//
// One place for: which environment we're in (Sandbox or Live), the
// merchant credentials for THAT environment only, request signing, ITN
// (payment notification) checks and refunds. Nothing here is ever sent
// to a browser except the signed checkout fields, which PayFast itself
// needs and which contain no secret (the passphrase is only hashed in).
//
// Secrets (Supabase -> Edge Functions -> Secrets, never in Git):
//   PAYFAST_MODE                 "sandbox" (default) or "live"
//   PAYFAST_SANDBOX_MERCHANT_ID  from sandbox.payfast.co.za
//   PAYFAST_SANDBOX_MERCHANT_KEY
//   PAYFAST_SANDBOX_PASSPHRASE   set the same value in the sandbox dashboard
//   PAYFAST_LIVE_MERCHANT_ID     only after PayFast approves the account
//   PAYFAST_LIVE_MERCHANT_KEY
//   PAYFAST_LIVE_PASSPHRASE
//   PAYFAST_ALLOW_LIVE           must be exactly "yes" for live to work
//
// Live needs BOTH PAYFAST_MODE=live AND PAYFAST_ALLOW_LIVE=yes, so one
// mistyped secret can never start taking real money. Each mode only ever
// reads its own credential set, so sandbox and live keys can't be mixed,
// and a sandbox merchant id that equals the live one is refused.
// ============================================================
import { createHash } from "node:crypto";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type PayfastMode = "sandbox" | "live";

export interface PayfastConfig {
  mode: PayfastMode;
  merchantId: string;
  merchantKey: string;
  passphrase: string;
  processUrl: string;
  validateUrl: string;
  apiBase: string;
  notifyUrl: string;
}

const HOSTS: Record<PayfastMode, string> = {
  sandbox: "https://sandbox.payfast.co.za",
  live: "https://www.payfast.co.za",
};

// Overridable only so the local test harness can point at a stand-in.
const hostFor = (mode: PayfastMode) => Deno.env.get("PAYFAST_HOST_OVERRIDE") || HOSTS[mode];
const apiBaseFor = () => Deno.env.get("PAYFAST_API_OVERRIDE") || "https://api.payfast.co.za";

export function payfastConfig(): { config: PayfastConfig } | { error: string } {
  const env = (k: string) => (Deno.env.get(k) || "").trim();
  const wanted = env("PAYFAST_MODE").toLowerCase() || "sandbox";
  if (wanted !== "sandbox" && wanted !== "live") return { error: "PAYFAST_MODE must be sandbox or live." };
  if (wanted === "live" && env("PAYFAST_ALLOW_LIVE") !== "yes") {
    return { error: "Live payments are not switched on (PAYFAST_ALLOW_LIVE)." };
  }
  const mode = wanted as PayfastMode;
  const prefix = mode === "live" ? "PAYFAST_LIVE_" : "PAYFAST_SANDBOX_";
  const merchantId = env(prefix + "MERCHANT_ID");
  const merchantKey = env(prefix + "MERCHANT_KEY");
  const passphrase = env(prefix + "PASSPHRASE");
  if (!merchantId || !merchantKey) return { error: `PayFast ${mode} is not set up yet.` };
  if (!passphrase) return { error: `PayFast ${mode} passphrase is missing.` };
  if (mode === "sandbox" && merchantId === env("PAYFAST_LIVE_MERCHANT_ID")) {
    return { error: "The sandbox merchant id is the live one. Use your sandbox account details." };
  }
  const host = hostFor(mode);
  return {
    config: {
      mode, merchantId, merchantKey, passphrase,
      processUrl: `${host}/eng/process`,
      validateUrl: `${host}/eng/query/validate`,
      apiBase: apiBaseFor(),
      notifyUrl: Deno.env.get("PAYFAST_NOTIFY_URL") || `${Deno.env.get("SUPABASE_URL")}/functions/v1/payfast-itn`,
    },
  };
}

// ---------- encoding + signatures ----------
// PayFast runs PHP: urlencode() turns spaces into "+" and hex-encodes
// everything except letters, digits and - _ . (upper-case hex).
export function phpUrlencode(value: string) {
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/[!'()*~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
// PayFast's own JavaScript sample (encodeURIComponent, spaces as "+").
// Identical to the PHP form except for ! ' ( ) * ~ ; used only as a
// second try when checking an incoming ITN.
function jsUrlencode(value: string) {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

function md5Hex(text: string) {
  return createHash("md5").update(text, "utf8").digest("hex");
}

// The checkout fields, in the exact order PayFast documents (the
// signature is computed over them in this order).
const CHECKOUT_FIELD_ORDER = [
  "merchant_id", "merchant_key", "return_url", "cancel_url", "notify_url",
  "name_first", "name_last", "email_address", "cell_number",
  "m_payment_id", "amount", "item_name", "item_description",
  "custom_int1", "custom_int2", "custom_int3", "custom_int4", "custom_int5",
  "custom_str1", "custom_str2", "custom_str3", "custom_str4", "custom_str5",
  "email_confirmation", "confirmation_address", "payment_method",
];

// Free text sent to PayFast is kept to plain characters, so the
// signature is the same however PayFast's side encodes it.
export function plainText(value: string, max: number) {
  return String(value || "").replace(/[^A-Za-z0-9 .,&:\-]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

export async function signedCheckout(config: PayfastConfig, input: {
  reference: string; amount: number; itemName: string; itemDescription?: string;
  email?: string | null; returnUrl: string; cancelUrl: string; customStr1?: string;
}) {
  const fields: Record<string, string> = {
    merchant_id: config.merchantId,
    merchant_key: config.merchantKey,
    return_url: input.returnUrl,
    cancel_url: input.cancelUrl,
    notify_url: config.notifyUrl,
    email_address: input.email ? String(input.email).trim() : "",
    m_payment_id: input.reference,
    amount: input.amount.toFixed(2),
    item_name: plainText(input.itemName, 100) || "ClickFood order",
    item_description: plainText(input.itemDescription || "", 255),
    custom_str1: input.customStr1 || "",
  };
  const ordered: Array<[string, string]> = CHECKOUT_FIELD_ORDER
    .filter((k) => fields[k] !== undefined && String(fields[k]).trim() !== "")
    .map((k) => [k, String(fields[k]).trim()]);
  const base = ordered.map(([k, v]) => `${k}=${phpUrlencode(v)}`).join("&");
  const signature = await md5Hex(`${base}&passphrase=${phpUrlencode(config.passphrase)}`);
  const out: Record<string, string> = Object.fromEntries(ordered);
  out.signature = signature;
  return { fields: out, url: `${config.processUrl}?${base}&signature=${signature}` };
}

// ---------- ITN (payment notification) checks ----------
// pairs: the POSTed fields in the order PayFast sent them.
export async function itnSignatureValid(pairs: Array<[string, string]>, passphrase: string) {
  const given = (pairs.find(([k]) => k === "signature") || [])[1] || "";
  if (!given) return false;
  const body = pairs.filter(([k]) => k !== "signature");
  for (const enc of [phpUrlencode, jsUrlencode]) {
    const base = body.map(([k, v]) => `${k}=${enc(v)}`).join("&");
    if (await md5Hex(`${base}&passphrase=${enc(passphrase)}`) === given.toLowerCase()) return true;
  }
  return false;
}

// Asks PayFast itself whether it really sent this notification. The
// request goes OUT to PayFast's own address, so it can't be faked by
// whoever posted the ITN.
export async function itnConfirmedByPayfast(config: PayfastConfig, pairs: Array<[string, string]>) {
  const body = pairs.filter(([k]) => k !== "signature").map(([k, v]) => `${k}=${phpUrlencode(v)}`).join("&");
  try {
    const res = await fetch(config.validateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    return (await res.text()).trim() === "VALID";
  } catch (_e) {
    return false;
  }
}

// PayFast's published notification addresses. Logged, not enforced: the
// address a request arrives from behind Supabase's proxy isn't always the
// sender's, and the signature + PayFast's own confirmation above already
// prove the notification is genuine.
const PAYFAST_RANGES = ["197.97.145.144/28", "41.74.179.192/27", "102.216.36.0/28", "102.216.36.128/28", "144.126.193.139/32"];
export function fromPayfastAddress(ip: string) {
  const toInt = (a: string) => a.split(".").reduce((n, p) => (n << 8) + (Number(p) & 255), 0) >>> 0;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  return PAYFAST_RANGES.some((r) => {
    const [net, bits] = r.split("/");
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return ((toInt(ip) & mask) >>> 0) === ((toInt(net) & mask) >>> 0);
  });
}

// ---------- Refunds ----------
// PayFast's API is signed with the merchant headers + body + passphrase,
// sorted by name. The sandbox can't refund, so in sandbox nothing is
// sent: the caller records the refund as due instead.
async function apiSignature(params: Record<string, string>) {
  const keys = Object.keys(params).sort();
  return md5Hex(keys.map((k) => `${k}=${phpUrlencode(params[k])}`).join("&"));
}

function saTimestamp() {
  // PayFast wants ISO 8601 with an offset; South Africa is UTC+02:00 all year.
  const d = new Date(Date.now() + 2 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 19) + "+02:00";
}

export type RefundResult =
  | { ok: true; refundReference: string }
  | { ok: false; sandbox: true; error: string }
  | { ok: false; sandbox?: false; error: string; legacy?: boolean };

// reference: our own payment reference (checkout_sessions.reference).
// amount: rands; omitted = the whole payment.
export async function refundPayment(admin: SupabaseClient, reference: string, amount: number | null, reason: string): Promise<RefundResult> {
  const { data: session } = await admin.from("checkout_sessions")
    .select("provider, environment, provider_payment_id, amount").eq("reference", reference).maybeSingle();
  if (!session) return { ok: false, error: "Payment not found." };
  if (session.provider !== "payfast") {
    return { ok: false, legacy: true, error: "This was an older Paystack test payment, so it can't be refunded automatically." };
  }
  return refundPayfastPayment(session.environment, session.provider_payment_id, amount ?? Number(session.amount), reason);
}

export async function refundPayfastPayment(environment: string | null, pfPaymentId: string | null, amount: number, reason: string): Promise<RefundResult> {
  if (environment !== "live") return { ok: false, sandbox: true, error: "Test payment: no real refund is sent in sandbox." };
  if (!pfPaymentId) return { ok: false, error: "PayFast hasn't confirmed this payment's id yet." };
  const cfg = payfastConfig();
  if ("error" in cfg) return { ok: false, error: cfg.error };
  const config = cfg.config;
  if (config.mode !== "live") return { ok: false, error: "This is a live payment but PayFast is in sandbox mode. Refund it from the PayFast dashboard." };

  const body = { amount: String(Math.round(amount * 100)), reason: plainText(reason, 120) || "Refund" };
  const headers = { "merchant-id": config.merchantId, version: "v1", timestamp: saTimestamp() };
  const signature = await apiSignature({ ...headers, ...body, passphrase: config.passphrase });
  try {
    const res = await fetch(`${config.apiBase}/refunds/${encodeURIComponent(pfPaymentId)}`, {
      method: "POST",
      headers: { ...headers, signature, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && (data?.status === "success" || data?.data?.response === true)) {
      return { ok: true, refundReference: `pf_refund:${pfPaymentId}:${Date.now()}` };
    }
    return { ok: false, error: data?.data?.message || data?.message || `PayFast refund error ${res.status}` };
  } catch (e) {
    return { ok: false, error: `PayFast refund request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// Return / cancel addresses must be ClickFood's own pages (or a local
// dev server), never anywhere a caller chooses.
export function allowedReturnUrl(url: string) {
  const extra = (Deno.env.get("PAYFAST_RETURN_ORIGINS") || "").split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const u = new URL(url);
    if (extra.includes(u.origin)) return true;
    if (u.protocol === "https:" && (u.hostname === "clickfood.co.za" || u.hostname === "www.clickfood.co.za")) return true;
    if (u.protocol === "https:" && /^clickfud-customer(-[a-z0-9-]+)?\.vercel\.app$/.test(u.hostname)) return true;
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return true;
    return false;
  } catch (_e) {
    return false;
  }
}

export function withParams(url: string, params: Record<string, string>) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
