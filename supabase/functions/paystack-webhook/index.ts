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
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const paystackSecretKey = Deno.env.get("PAYSTACK_SECRET_KEY")!;

async function logEvent(admin: SupabaseClient, row: {
  event_type: string; reference?: string | null; order_id?: string | null; customer_id?: string | null; status?: string | null; failure_reason?: string | null;
}) {
  try { await admin.from("payment_events").insert({ source: "paystack-webhook", ...row }); } catch (_e) { /* never fail webhook processing over a logging error */ }
}

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

    const admin = createClient(supabaseUrl, serviceRoleKey);

    if (!signature || signature !== expected) {
      // Never process an unsigned/mis-signed request — this is the only
      // thing standing between this endpoint and anyone on the internet
      // being able to fabricate a "payment succeeded" event. Logged (not
      // just silently rejected) so an admin can see if someone is probing
      // this endpoint.
      await logEvent(admin, { event_type: "invalid_signature", status: "rejected" });
      return new Response("Invalid signature", { status: 401 });
    }

    const event = JSON.parse(rawBody);

    // RecessBox shares this Paystack account (and Paystack allows only one
    // webhook URL), so its payments arrive here too — references start with
    // "rb_", never used by clickFud. Pass a signed "please re-check this
    // reference" note to RecessBox; it verifies with Paystack itself and
    // never trusts this message's contents. clickFud orders are untouched.
    const rbReference = String(event.data?.reference || "");
    if (rbReference.startsWith("rb_")) {
      try {
        const bridgeSecret = Deno.env.get("CAMPUSBOX_BRIDGE_SECRET") || "";
        const target = Deno.env.get("RECESSBOX_WEBHOOK_URL") || "https://campusbox-three.vercel.app/api/paystack/webhook";
        const note = JSON.stringify({ reference: rbReference, event: event.event, ts: Date.now() });
        const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(bridgeSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const sigBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(note)));
        const sig = btoa(String.fromCharCode(...sigBytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        const res = await fetch(target, { method: "POST", headers: { "Content-Type": "application/json", "x-recessbox-signature": sig }, body: note });
        await logEvent(admin, { event_type: "recessbox_forward", reference: rbReference, status: res.ok ? "forwarded" : `forward_http_${res.status}` });
      } catch (e) {
        await logEvent(admin, { event_type: "recessbox_forward", reference: rbReference, status: "forward_error", failure_reason: String(e) });
      }
      return new Response("OK", { status: 200 });
    }

    if (event.event === "charge.success") {
      const reference = event.data?.reference;
      if (reference) {
        const { data: session } = await admin.from("checkout_sessions").select("status,amount,currency,customer_id").eq("reference", reference).maybeSingle();
        // 'failed' is accepted too: a signed charge.success with the exact
        // amount is Paystack's definitive word that the money was taken, so
        // an earlier premature 'failed' (paystack-verify used to mark
        // sessions failed while Paystack was still 'ongoing') must never
        // leave a paid student without their order. finalize_paystack_
        // checkout row-locks the session and skips it once 'paid', so a
        // repeated or racing delivery can't create orders twice.
        if (session && (session.status === "pending" || session.status === "failed")) {
          const expectedAmount = Math.round(Number(session.amount) * 100);
          if (event.data.amount === expectedAmount && event.data.currency === session.currency) {
            await admin.rpc("finalize_paystack_checkout", { p_reference: reference });
            await logEvent(admin, { event_type: "charge_success", reference, customer_id: session.customer_id, status: "paid" });
          } else {
            await admin.rpc("mark_paystack_checkout_failed", { p_reference: reference, p_reason: "amount_or_currency_mismatch" });
            await logEvent(admin, { event_type: "amount_mismatch", reference, customer_id: session.customer_id, status: "failed", failure_reason: "amount_or_currency_mismatch" });
          }
        }
      }
    } else if (event.event === "refund.processed" || event.event === "refund.failed") {
      // Paystack's own documented behaviour: a successful POST /refund
      // response only means the refund was QUEUED — the actual outcome is
      // reported here, asynchronously. This is the only place an order's
      // payment_status is ever allowed to become 'refunded'.
      //
      // Correlation: paystack-cancel-order stores the refund's own `id`
      // (from the /refund response) as orders.paystack_refund_reference.
      // This webhook's payload shape for the refund id wasn't independently
      // confirmed against live traffic (Paystack's docs don't publish a
      // full field-by-field example) — matched defensively against a few
      // plausible locations, and always logged either way so a miss is
      // still visible/reconcilable from payment_events rather than silent.
      const refundId = event.data?.id ?? event.data?.refund?.id;
      const outcome = event.event === "refund.processed" ? "refunded" : "refund_failed";
      let matched = false;
      if (refundId != null) {
        const { data: order } = await admin.from("orders")
          .select("id,customer_id").eq("paystack_refund_reference", String(refundId)).eq("payment_status", "refund_pending").maybeSingle();
        if (order) {
          await admin.from("orders").update({ payment_status: outcome, refunded_at: outcome === "refunded" ? new Date().toISOString() : null }).eq("id", order.id);
          await logEvent(admin, { event_type: `webhook_${outcome}`, order_id: order.id, customer_id: order.customer_id, status: outcome });
          matched = true;
        }
      }
      if (!matched) {
        await logEvent(admin, { event_type: `webhook_${outcome}_unmatched`, status: outcome, failure_reason: `refund id ${refundId} did not match any order awaiting refund` });
      }
    }

    // Paystack just needs a 200 to consider the webhook delivered.
    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 500 });
  }
});
