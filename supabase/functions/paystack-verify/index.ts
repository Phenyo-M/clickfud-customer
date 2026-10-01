// ============================================================
// CLICKFUD — paystack-verify Edge Function
//
// Called by the browser right after Paystack redirects the customer
// back (never trusted on its own — the browser is only telling us WHICH
// reference to check, not whether it succeeded). This function is the
// one that actually asks Paystack, server-side with the secret key,
// whether the payment really went through, and only then creates the
// real order rows via finalize_paystack_checkout(). Idempotent: calling
// this twice for the same reference (a page refresh, or racing the
// paystack-webhook function) never creates orders twice.
//
// Required secret: PAYSTACK_SECRET_KEY (same TEST key as paystack-initialize).
// ============================================================
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const paystackSecretKey = Deno.env.get("PAYSTACK_SECRET_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function logEvent(admin: SupabaseClient, row: {
  event_type: string; reference?: string | null; order_id?: string | null; customer_id?: string | null; status?: string | null; failure_reason?: string | null;
}) {
  try { await admin.from("payment_events").insert({ source: "paystack-verify", ...row }); } catch (_e) { /* never fail verification over a logging error */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return json({ error: "Please sign in." }, 401);

    const { reference } = await req.json() as { reference?: string };
    if (!reference) return json({ error: "Missing payment reference." });

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data: session } = await admin.from("checkout_sessions").select("*").eq("reference", reference).maybeSingle();
    if (!session) return json({ error: "Unknown payment reference." }, 404);
    if (session.customer_id !== userData.user.id) return json({ error: "This payment does not belong to your account." }, 403);

    // Already finalized (a previous verify call, or the webhook, got here
    // first) — return the same result rather than re-checking Paystack.
    if (session.status === "paid") {
      await logEvent(admin, { event_type: "verify_already_processed", reference, customer_id: session.customer_id, status: "paid" });
      return json({ ok: true, orderIds: session.order_ids, alreadyProcessed: true });
    }
    // A 'failed' session is still re-checked with Paystack below rather than
    // trusted: sessions used to be marked failed while Paystack was merely
    // 'ongoing'/'abandoned' (see NON_FINAL below), so a real, completed
    // payment could be sitting behind a stale 'failed'. Paystack's answer
    // is what counts.

    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${paystackSecretKey}` },
    });
    const verifyData = await verifyRes.json();

    const paystackStatus = verifyData.data?.status;
    const paidOk = verifyRes.ok && verifyData.status && paystackStatus === "success";
    const expectedAmount = Math.round(Number(session.amount) * 100);
    const amountOk = paidOk && verifyData.data?.amount === expectedAmount && verifyData.data?.currency === session.currency;

    // Not a final answer yet. The app now checks as soon as the student
    // returns to it — possibly while they're still on Paystack's page, or
    // before Paystack has finished processing. Marking the session failed
    // here (as this function used to) made the webhook ignore the later
    // charge.success: the student was charged but no order was created.
    // "abandoned" is included because Paystack reports it for a checkout
    // page that was opened but not (yet) paid — the student can still pay.
    const NON_FINAL = ["ongoing", "pending", "processing", "queued", "abandoned", "send_birthday", "send_otp", "send_pin", "send_phone", "send_address", "open_url"];
    if (!paidOk && (!verifyRes.ok || !paystackStatus || NON_FINAL.includes(paystackStatus))) {
      await logEvent(admin, { event_type: "verify_pending", reference, customer_id: session.customer_id, status: "pending", failure_reason: paystackStatus || `paystack_http_${verifyRes.status}` });
      return json({ ok: false, pending: true, paystackStatus: paystackStatus || null, error: "We're still waiting for Paystack to confirm this payment." });
    }
    if (session.status === "failed" && !paidOk) {
      return json({ ok: false, error: "Your order is incomplete — this payment was not completed." });
    }

    if (!paidOk || !amountOk) {
      const reason = !paidOk ? (paystackStatus || "not_successful") : "amount_or_currency_mismatch";
      await admin.rpc("mark_paystack_checkout_failed", { p_reference: reference, p_reason: reason });
      await logEvent(admin, { event_type: "verify_failed", reference, customer_id: session.customer_id, status: "failed", failure_reason: reason });
      // "abandoned" is Paystack's own status for a customer who backed out
      // of the hosted checkout page without paying — a real, common,
      // completely normal case (not a decline/error), worth telling the
      // customer plainly rather than a generic "not successful".
      const message = paidOk
        ? "Payment was not successful — your order is incomplete."
        : "Your payment was declined — your order was not placed. Please try again.";
      return json({ ok: false, error: message });
    }

    const { data: finalized, error: finalizeError } = await admin.rpc("finalize_paystack_checkout", { p_reference: reference });
    if (finalizeError) {
      await logEvent(admin, { event_type: "finalize_failed", reference, customer_id: session.customer_id, status: "error", failure_reason: String(finalizeError.message || finalizeError) });
      return json({ ok: false, error: "Payment succeeded but we couldn't create your order. Please contact support with reference " + reference + "." }, 500);
    }
    await logEvent(admin, { event_type: "verify_success", reference, customer_id: session.customer_id, status: "paid" });

    // Save the card for next time — only when Paystack itself marks this
    // exact authorization reusable (never assumed). This never touches the
    // card number/CVV/PIN at all: authorization_code is Paystack's own
    // opaque token for re-charging it later via
    // /transaction/charge_authorization, the only piece stored here.
    // Awaited (not fire-and-forget): an un-awaited promise isn't guaranteed
    // to finish after this function's response is sent in a serverless
    // runtime — a failure here logs but never fails the order itself,
    // which is already fully paid and created by this point regardless.
    const auth = verifyData.data?.authorization;
    if (auth?.reusable && auth?.authorization_code) {
      const { error: saveError } = await admin.from("payment_methods").upsert({
        customer_id: session.customer_id,
        paystack_authorization_code: auth.authorization_code,
        card_type: auth.card_type || null,
        bank: auth.bank || null,
        last4: auth.last4 || null,
        exp_month: auth.exp_month || null,
        exp_year: auth.exp_year || null,
      }, { onConflict: "customer_id,paystack_authorization_code", ignoreDuplicates: true });
      if (saveError) console.error("save payment method failed", saveError);
    }

    return json({ ok: true, orderIds: finalized.order_ids });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: "Something went wrong verifying your payment." }, 500);
  }
});
