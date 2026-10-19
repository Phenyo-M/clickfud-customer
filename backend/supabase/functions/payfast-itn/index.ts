// ============================================================
// CLICKFOOD — payfast-itn Edge Function (PayFast's payment notification)
//
// PayFast calls this address (notify_url) from its own servers whenever a
// payment changes state. It is the ONLY thing that marks a payment paid:
// a customer coming back to the app from PayFast proves nothing.
//
// Every notification is checked before anything changes:
//   1. signature: an MD5 over the posted fields + our passphrase
//   2. merchant: it is for OUR merchant id in the current mode
//   3. PayFast confirms it: the fields are posted back to PayFast's own
//      /eng/query/validate address, which must answer VALID
//   4. amount + environment: checked again inside the database
//      (apply_payfast_payment), against the amount saved when the
//      payment was started, under a row lock
// Duplicates are harmless: the same notification twice does nothing, and
// a second, separate payment for the same checkout is recorded and
// refunded (live) or recorded as due (sandbox).
//
// Answers 200 once a notification has been handled (or is safely
// ignorable) so PayFast stops resending; 4xx for forged/invalid ones.
// Deploy with --no-verify-jwt: PayFast doesn't send a Supabase token.
// ============================================================
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { fromPayfastAddress, itnConfirmedByPayfast, itnSignatureValid, payfastConfig } from "../_shared/payfast.ts";
import { refundDuplicatePayment, refundGroupPayments } from "../_shared/group-refund.ts";
import { clientKey, limited } from "../_shared/limit.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function logEvent(admin: SupabaseClient, row: {
  event_type: string; reference?: string | null; order_id?: string | null; customer_id?: string | null; status?: string | null; failure_reason?: string | null;
}) {
  try { await admin.from("payment_events").insert({ source: "payfast-itn", ...row }); } catch (_e) { /* never fail over logging */ }
}

const text = (body: string, status: number) => new Response(body, { status, headers: { "Content-Type": "text/plain" } });

async function forwardToRecessbox(admin: SupabaseClient, reference: string, event: string) {
  try {
    const bridgeSecret = Deno.env.get("CAMPUSBOX_BRIDGE_SECRET") || "";
    const target = Deno.env.get("RECESSBOX_WEBHOOK_URL") || "https://campusbox-three.vercel.app/api/payfast/webhook";
    const note = JSON.stringify({ reference, event, ts: Date.now() });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(bridgeSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sigBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(note)));
    const sig = btoa(String.fromCharCode(...sigBytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const res = await fetch(target, { method: "POST", headers: { "Content-Type": "application/json", "x-recessbox-signature": sig }, body: note });
    await logEvent(admin, { event_type: "recessbox_forward", reference, status: res.ok ? "forwarded" : `forward_http_${res.status}` });
  } catch (e) {
    await logEvent(admin, { event_type: "recessbox_forward", reference, status: "forward_error", failure_reason: String(e) });
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return text("Method not allowed", 405);
  const admin = createClient(supabaseUrl, serviceRoleKey);
  const tooMany = await limited(admin, await clientKey(req), "payfast_itn", 300, 60, {});
  if (tooMany) return tooMany;

  try {
    const cfg = payfastConfig();
    if ("error" in cfg) {
      // Not set up: answer with an error so PayFast tries again later.
      await logEvent(admin, { event_type: "itn_not_configured", status: "error", failure_reason: cfg.error });
      return text("Not configured", 503);
    }
    const config = cfg.config;

    const raw = await req.text();
    const pairs = Array.from(new URLSearchParams(raw).entries());
    const field = (k: string) => (pairs.find(([key]) => key === k) || [])[1] || "";
    const reference = field("m_payment_id");
    const pfPaymentId = field("pf_payment_id");
    const status = field("payment_status").toUpperCase();

    if (!(await itnSignatureValid(pairs, config.passphrase))) {
      await logEvent(admin, { event_type: "itn_invalid_signature", reference: reference || null, status: "rejected" });
      return text("Invalid signature", 400);
    }
    if (field("merchant_id") !== config.merchantId) {
      await logEvent(admin, { event_type: "itn_wrong_merchant", reference: reference || null, status: "rejected", failure_reason: `merchant ${field("merchant_id")} in ${config.mode} mode` });
      return text("Wrong merchant", 400);
    }
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
    if (!fromPayfastAddress(ip)) {
      await logEvent(admin, { event_type: "itn_unlisted_address", reference: reference || null, status: "note", failure_reason: ip || "no address" });
    }
    if (!(await itnConfirmedByPayfast(config, pairs))) {
      await logEvent(admin, { event_type: "itn_not_confirmed", reference: reference || null, status: "rejected" });
      return text("Not confirmed by PayFast", 400);
    }
    if (!reference) {
      await logEvent(admin, { event_type: "itn_no_reference", status: "ignored" });
      return text("OK", 200);
    }
    const amount = Number(field("amount_gross"));

    // ---------- RecessBox (references start with rb_) ----------
    if (reference.startsWith("rb_")) {
      const { data: bp } = await admin.from("bridge_payments").select("*").eq("reference", reference).maybeSingle();
      if (!bp) {
        await logEvent(admin, { event_type: "recessbox_unknown_reference", reference, status: "ignored" });
        return text("OK", 200);
      }
      if (bp.environment !== config.mode) {
        await logEvent(admin, { event_type: "recessbox_environment_mismatch", reference, status: "rejected" });
        return text("OK", 200);
      }
      if (status === "COMPLETE") {
        if (Math.round(amount * 100) !== Number(bp.amount_cents)) {
          await admin.from("bridge_payments").update({ status: "failed", failure_reason: "amount_mismatch", updated_at: new Date().toISOString() }).eq("reference", reference).eq("status", "pending");
          await logEvent(admin, { event_type: "recessbox_amount_mismatch", reference, status: "failed" });
        } else {
          await admin.from("bridge_payments").update({ status: "success", provider_payment_id: pfPaymentId, failure_reason: null, updated_at: new Date().toISOString() })
            .eq("reference", reference).neq("status", "success");
        }
      } else if (status === "FAILED" || status === "CANCELLED") {
        await admin.from("bridge_payments").update({ status: "failed", failure_reason: status.toLowerCase(), updated_at: new Date().toISOString() }).eq("reference", reference).eq("status", "pending");
      }
      await forwardToRecessbox(admin, reference, status);
      return text("OK", 200);
    }

    // ---------- ClickFood ----------
    if (status === "COMPLETE") {
      const { data: result, error } = await admin.rpc("apply_payfast_payment", {
        p_reference: reference, p_pf_payment_id: pfPaymentId, p_amount: amount, p_environment: config.mode,
      });
      if (error) {
        // a database problem: let PayFast resend, nothing was applied
        await logEvent(admin, { event_type: "itn_apply_failed", reference, status: "error", failure_reason: error.message });
        return text("Try again", 500);
      }
      if (result?.error) {
        await logEvent(admin, { event_type: `itn_${result.error}`, reference, customer_id: result.customer_id || null, status: "rejected" });
        return text("OK", 200);
      }
      if (result?.duplicate) {
        await logEvent(admin, { event_type: "itn_duplicate_payment", reference, customer_id: result.customer_id || null, status: "refund_due" });
        await refundDuplicatePayment(admin, pfPaymentId);
        return text("OK", 200);
      }
      await logEvent(admin, { event_type: result?.already ? "itn_already_applied" : "itn_paid", reference, customer_id: result?.customer_id || null, status: "paid" });
      // a group share paid after the group was cancelled, or paid twice
      if (result?.refund_reference || result?.refund_group) {
        await refundGroupPayments(admin, { groupId: result.refund_group ? result.group_id : null, reference: result.refund_reference || null });
      }
      return text("OK", 200);
    }

    if (status === "FAILED" || status === "CANCELLED") {
      // 'abandoned' turns an open group share back to "not paid"
      await admin.rpc("mark_paystack_checkout_failed", { p_reference: reference, p_reason: status === "CANCELLED" ? "abandoned" : "payfast_failed" });
      await logEvent(admin, { event_type: `itn_${status.toLowerCase()}`, reference, status: "failed" });
      return text("OK", 200);
    }

    await logEvent(admin, { event_type: "itn_status_" + (status.toLowerCase() || "unknown"), reference, status: "pending" });
    return text("OK", 200);
  } catch (e) {
    console.error(e);
    await logEvent(admin, { event_type: "itn_error", status: "error", failure_reason: String(e) });
    return text("Error", 500);
  }
});
