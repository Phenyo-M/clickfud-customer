// ============================================================
// CLICKFOOD — payfast-status Edge Function
//
// The app asks this whenever it has reason to think a payment may have
// finished: PayFast sent the customer back, the app was reopened, a live
// update arrived. It only REPORTS what the server already knows; it never
// marks anything paid. Payments are confirmed solely by payfast-itn after
// PayFast's own verified notification, so coming back from PayFast (or
// faking the return address) can't place an order.
//
// Body: { reference, cancelled? }  (cancelled: they used PayFast's
// "cancel" link; the payment stays open so they can still finish it)
// Answers (same shape the app used before):
//   { ok: true, orderIds, groupId?, shareStatus?, placed? }   paid
//   { ok: false, pending: true, gatewayStatus }               not confirmed yet
//   { ok: false, error }                                      failed / not yours
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return json({ error: "Please sign in." }, 401);

    const { reference, cancelled } = await req.json() as { reference?: string; cancelled?: boolean };
    if (!reference) return json({ error: "Missing payment reference." });

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data: session } = await admin.from("checkout_sessions")
      .select("reference, customer_id, status, order_ids, group_id, share_user_id, failure_reason, provider")
      .eq("reference", reference).maybeSingle();
    if (!session) return json({ error: "Unknown payment reference." }, 404);
    if (session.customer_id !== userData.user.id) return json({ error: "This payment does not belong to your account." }, 403);

    if (session.status === "paid") {
      const orderIds = Array.isArray(session.order_ids) ? session.order_ids : [];
      if (session.group_id) {
        const { data: share } = await admin.from("group_order_shares").select("status")
          .eq("group_id", session.group_id).eq("user_id", session.share_user_id).maybeSingle();
        return json({ ok: true, orderIds, groupId: session.group_id, shareStatus: share?.status || undefined, placed: orderIds.length > 0 });
      }
      return json({ ok: true, orderIds });
    }

    if (session.status === "failed") {
      const reason = String(session.failure_reason || "");
      const message = reason === "amount_mismatch"
        ? "We couldn't confirm this payment. Please contact ClickFood support."
        : "Your payment didn't go through. Your order was not placed.";
      return json({ ok: false, error: message, groupId: session.group_id || undefined });
    }

    // Still pending: PayFast hasn't sent a verified notification yet.
    return json({ ok: false, pending: true, gatewayStatus: cancelled ? "cancelled" : "waiting", groupId: session.group_id || undefined });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: "Something went wrong checking your payment." }, 500);
  }
});
