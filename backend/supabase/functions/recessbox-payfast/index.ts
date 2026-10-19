// =========================================================================
// CLICKFOOD — recessbox-payfast Edge Function
//
// RecessBox takes card payments through the SAME PayFast account as
// ClickFood. Rather than copying the PayFast credentials into a second
// app, RecessBox's SERVER asks this function to (a) start a payment and
// (b) check one. The credentials never leave ClickFood's Supabase secrets.
//
// Only RecessBox's server can call it: every request is HMAC-signed with
// CAMPUSBOX_BRIDGE_SECRET (shared by the two servers only, never sent to a
// browser) and must be less than 5 minutes old. It only ever touches
// RecessBox payments (references start with "rb_").
//
// Same answers as the old Paystack bridge, so RecessBox's code keeps
// working: "initialize" returns authorization_url (a signed PayFast link),
// "verify" returns status "success" only once payfast-itn has verified
// PayFast's notification for that exact reference and amount.
//
// Deploy with --no-verify-jwt (server-to-server, no user session).
// =========================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { payfastConfig, signedCheckout, withParams } from "../_shared/payfast.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const bridgeSecret = Deno.env.get("CAMPUSBOX_BRIDGE_SECRET")!;
const ALLOWED_CALLBACKS = [/^https:\/\/campusbox-three\.vercel\.app\//, /^http:\/\/localhost:\d+\//];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function toBase64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function validSignature(rawBody: string, signature: string) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(bridgeSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const expected = toBase64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody))));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const rawBody = await req.text();
    if (!bridgeSecret || !(await validSignature(rawBody, req.headers.get("x-recessbox-signature") || ""))) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body = JSON.parse(rawBody);
    if (typeof body.ts !== "number" || Math.abs(Date.now() - body.ts) > 5 * 60 * 1000) {
      return json({ error: "Request expired" }, 401);
    }
    const reference = String(body.reference || "");
    if (!/^rb_[A-Za-z0-9_-]{8,80}$/.test(reference)) return json({ error: "Invalid reference" }, 400);

    const admin = createClient(supabaseUrl, serviceRoleKey);

    if (body.action === "initialize") {
      const amount = Number(body.amount_cents);
      if (!Number.isInteger(amount) || amount < 100 || amount > 10_000_000) return json({ error: "Invalid amount" }, 400);
      const email = String(body.email || "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: "Invalid email" }, 400);
      const callback = String(body.callback_url || "");
      if (!ALLOWED_CALLBACKS.some((re) => re.test(callback))) return json({ error: "Invalid callback" }, 400);

      const cfg = payfastConfig();
      if ("error" in cfg) return json({ error: "Online payment isn't available right now." }, 503);

      const { data: existing } = await admin.from("bridge_payments").select("status, amount_cents, environment").eq("reference", reference).maybeSingle();
      if (existing && (existing.status !== "pending" || existing.amount_cents !== amount || existing.environment !== cfg.config.mode)) {
        return json({ error: "This payment reference was already used." }, 409);
      }
      if (!existing) {
        const { error } = await admin.from("bridge_payments").insert({
          reference, app: "recessbox", amount_cents: amount, environment: cfg.config.mode,
          booking_id: String(body.booking_id || "") || null, booking_code: String(body.booking_code || "") || null,
        });
        if (error) return json({ error: "Could not start the payment." }, 500);
      }
      const signed = await signedCheckout(cfg.config, {
        reference, amount: amount / 100, email,
        itemName: `RecessBox booking ${String(body.booking_code || "")}`,
        returnUrl: withParams(callback, { reference }),
        cancelUrl: withParams(callback, { reference, payment: "cancelled" }),
      });
      return json({ authorization_url: signed.url, reference });
    }

    if (body.action === "verify") {
      const { data: bp } = await admin.from("bridge_payments").select("*").eq("reference", reference).maybeSingle();
      if (!bp) return json({ status: "unknown" });
      return json({
        status: bp.status,               // "success" | "pending" | "failed"
        amount_cents: bp.amount_cents,
        currency: bp.currency,
        booking_id: bp.booking_id,
        app: bp.app,
      });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("recessbox-payfast", e);
    return json({ error: "Something went wrong." }, 500);
  }
});
