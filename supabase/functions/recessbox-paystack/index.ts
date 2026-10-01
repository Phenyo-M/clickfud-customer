// =========================================================================
// CLICKFUD — recessbox-paystack Edge Function
//
// RecessBox takes card payments through the SAME Paystack account as
// clickFud. Rather than copying the Paystack secret key into a second app,
// RecessBox's SERVER asks this function to (a) start a payment and (b) check
// one. The key never leaves clickFud's Supabase secrets.
//
// Only RecessBox's server can call it: every request is HMAC-signed with
// CAMPUSBOX_BRIDGE_SECRET (shared by the two servers only, never sent to a
// browser) and must be less than 5 minutes old. It only ever touches
// RecessBox payments — references must start with "rb_" — so it can't be
// used to look at or create clickFud transactions.
//
// Deploy with --no-verify-jwt (server-to-server, no user session).
// =========================================================================

const paystackSecretKey = Deno.env.get("PAYSTACK_SECRET_KEY")!;
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
    if (!(await validSignature(rawBody, req.headers.get("x-recessbox-signature") || ""))) {
      return json({ error: "Unauthorized" }, 401);
    }
    const body = JSON.parse(rawBody);
    if (typeof body.ts !== "number" || Math.abs(Date.now() - body.ts) > 5 * 60 * 1000) {
      return json({ error: "Request expired" }, 401);
    }
    const reference = String(body.reference || "");
    if (!/^rb_[A-Za-z0-9_-]{8,80}$/.test(reference)) return json({ error: "Invalid reference" }, 400);

    if (body.action === "initialize") {
      const amount = Number(body.amount_cents);
      if (!Number.isInteger(amount) || amount < 100 || amount > 10_000_000) return json({ error: "Invalid amount" }, 400);
      const email = String(body.email || "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: "Invalid email" }, 400);
      const callback = String(body.callback_url || "");
      if (!ALLOWED_CALLBACKS.some((re) => re.test(callback))) return json({ error: "Invalid callback" }, 400);

      const res = await fetch("https://api.paystack.co/transaction/initialize", {
        method: "POST",
        headers: { Authorization: `Bearer ${paystackSecretKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          email, amount, currency: "ZAR", reference, callback_url: callback,
          metadata: { app: "recessbox", booking_id: String(body.booking_id || ""), booking_code: String(body.booking_code || "") },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.status) return json({ error: data?.message || "Paystack could not start the payment." }, 502);
      return json({ authorization_url: data.data.authorization_url, reference: data.data.reference });
    }

    if (body.action === "verify") {
      const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${paystackSecretKey}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.status) return json({ status: "unknown" });
      const d = data.data || {};
      return json({
        status: d.status,                 // "success" | "abandoned" | "failed" | "ongoing" | …
        amount_cents: d.amount,
        currency: d.currency,
        booking_id: d.metadata?.booking_id || null,
        app: d.metadata?.app || null,
      });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("recessbox-paystack", e);
    return json({ error: "Something went wrong." }, 500);
  }
});
