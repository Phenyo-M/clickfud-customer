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
import { createClient } from "npm:@supabase/supabase-js@2";

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
      return json({ ok: true, orderIds: session.order_ids, alreadyProcessed: true });
    }
    if (session.status === "failed") {
      return json({ ok: false, error: "This payment was not completed." });
    }

    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${paystackSecretKey}` },
    });
    const verifyData = await verifyRes.json();

    const paidOk = verifyRes.ok && verifyData.status && verifyData.data?.status === "success";
    const expectedAmount = Math.round(Number(session.amount) * 100);
    const amountOk = paidOk && verifyData.data?.amount === expectedAmount && verifyData.data?.currency === session.currency;

    if (!paidOk || !amountOk) {
      await admin.rpc("mark_paystack_checkout_failed", { p_reference: reference });
      return json({ ok: false, error: "Payment was not successful." });
    }

    const { data: finalized, error: finalizeError } = await admin.rpc("finalize_paystack_checkout", { p_reference: reference });
    if (finalizeError) return json({ ok: false, error: "Payment succeeded but we couldn't create your order. Please contact support with reference " + reference + "." }, 500);

    return json({ ok: true, orderIds: finalized.order_ids });
  } catch (e) {
    return json({ ok: false, error: "Something went wrong verifying your payment." }, 500);
  }
});
