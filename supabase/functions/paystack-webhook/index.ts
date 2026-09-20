// ============================================================
// CLICKFUD — paystack-webhook Edge Function
//
// Resilience path: if a customer closes the tab/browser right after
// paying and never returns to trigger paystack-verify, this is what
// still creates their order. Paystack calls this URL directly (server
// to server), so it must independently verify authenticity — Paystack
// signs every webhook body with HMAC-SHA512 using the same secret key,
// sent as the x-paystack-signature header. A request with a missing or
// wrong signature is rejected outright and never touches the database.
//
// Manual step required (cannot be done from code): paste this function's
// URL into the Paystack Dashboard under Settings -> API Keys & Webhooks
// -> Webhook URL, in TEST mode.
//
// Required secret: PAYSTACK_SECRET_KEY (same TEST key as the other two
// paystack-* functions — Paystack does not use a separate webhook secret).
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const paystackSecretKey = Deno.env.get("PAYSTACK_SECRET_KEY")!;

async function hmacSha512Hex(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-512" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  try {
    const rawBody = await req.text();
    const signature = req.headers.get("x-paystack-signature") || "";
    const expected = await hmacSha512Hex(paystackSecretKey, rawBody);

    if (!signature || signature !== expected) {
      // Never process an unsigned/mis-signed request — this is the only
      // thing standing between this endpoint and anyone on the internet
      // being able to fabricate a "payment succeeded" event.
      return new Response("Invalid signature", { status: 401 });
    }

    const event = JSON.parse(rawBody);
    if (event.event === "charge.success") {
      const reference = event.data?.reference;
      if (reference) {
        const admin = createClient(supabaseUrl, serviceRoleKey);
        const { data: session } = await admin.from("checkout_sessions").select("status,amount,currency").eq("reference", reference).maybeSingle();
        if (session && session.status === "pending") {
          const expectedAmount = Math.round(Number(session.amount) * 100);
          if (event.data.amount === expectedAmount && event.data.currency === session.currency) {
            await admin.rpc("finalize_paystack_checkout", { p_reference: reference });
          } else {
            await admin.rpc("mark_paystack_checkout_failed", { p_reference: reference });
          }
        }
      }
    }

    // Paystack just needs a 200 to consider the webhook delivered.
    return new Response("ok", { status: 200 });
  } catch (e) {
    return new Response("error", { status: 500 });
  }
});
