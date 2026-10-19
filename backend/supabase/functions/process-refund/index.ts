// ============================================================
// CLICKFOOD — process-refund
//
// Pays out an APPROVED refund request (refund_requests, see
// supabase/manager_reports.sql) on a CARD order through PayFast.
// Cash refunds don't come here: the manager marks those paid in the app.
//
//  * Only the manager of the order's shop can call it (checked here and
//    again by the database functions it uses).
//  * The request is "claimed" first (processing_started_at), so two clicks
//    can't send two refunds; a claim older than 5 minutes can be retried.
//  * PayFast's own limit also applies: it never refunds more than the
//    original payment.
//  * Sandbox can't send refunds: nothing is sent and the request stays
//    approved (due).
//
// Secrets: see supabase/functions/_shared/payfast.ts.
// ============================================================
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { refundPayment } from "../_shared/payfast.ts";

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

async function logEvent(admin: SupabaseClient, row: {
  event_type: string; reference?: string | null; order_id?: string | null; customer_id?: string | null; status?: string | null; failure_reason?: string | null;
}) {
  try { await admin.from("payment_events").insert({ source: "process-refund", ...row }); } catch (_e) { /* never fail a refund over a logging error */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return json({ error: "Please sign in." }, 401);

    const { requestId } = await req.json() as { requestId?: string };
    if (!requestId) return json({ error: "Missing refund request." });

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data: request } = await admin.from("refund_requests").select("*").eq("id", requestId).single();
    if (!request) return json({ error: "Refund request not found." }, 404);
    // Checked as the signed-in person (their own token), so the database sees
    // their role, the shop's "Refunds" permission AND whether they entered
    // their two-step login code this session (staff_permissions.sql).
    const { error: permError } = await userClient.rpc("assert_store_perm", { p_store: request.store_id, p_perm: "process_refunds" });
    if (permError) return json({ error: permError.message || "You don't have access to refunds." }, 403);
    if (request.status === "paid") return json({ ok: true, request });
    if (request.status !== "approved") return json({ error: "Only approved refunds can be paid out." });

    const { data: order } = await admin.from("orders").select("id, order_number, customer_id, payment_method, payment_status, payment_reference, total, delivery_location").eq("id", request.order_id).single();
    if (!order) return json({ error: "Order not found." }, 404);
    if (order.delivery_location && order.delivery_location.group_pay === "each") {
      return json({ error: "This group order was paid by several people, so it can't be refunded here. Please contact ClickFood support." });
    }

    if (order.payment_method !== "card" || !order.payment_reference) return json({ error: "This is not a card order. Mark cash refunds as paid in the app." });

    // Claim it: only one caller at a time gets past this point.
    const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: claimed } = await admin.from("refund_requests")
      .update({ processing_started_at: new Date().toISOString() })
      .eq("id", requestId).eq("status", "approved")
      .or(`processing_started_at.is.null,processing_started_at.lt.${staleBefore}`)
      .select("id").maybeSingle();
    if (!claimed) return json({ error: "This refund is already being processed. Please wait a moment." });

    const refund = await refundPayment(admin, order.payment_reference, Number(request.amount), `Refund for order ${order.order_number}`);
    if (!refund.ok) {
      await admin.from("refund_requests").update({ processing_started_at: null }).eq("id", requestId);
      if (("sandbox" in refund && refund.sandbox) || ("legacy" in refund && refund.legacy)) {
        // nothing could be sent: the request stays approved (due)
        await logEvent(admin, { event_type: "refund_request_not_sent", reference: order.payment_reference, order_id: order.id, customer_id: order.customer_id, status: "due", failure_reason: refund.error });
        return json({ error: refund.error, notSent: true });
      }
      await admin.rpc("mark_refund_failed", { p_request_id: requestId, p_reason: refund.error });
      await logEvent(admin, { event_type: "refund_request_failed", reference: order.payment_reference, order_id: order.id, customer_id: order.customer_id, status: "failed", failure_reason: refund.error });
      return json({ error: `PayFast could not process this refund: ${refund.error}` });
    }

    const { data: paid, error: paidError } = await admin.rpc("mark_refund_paid", { p_request_id: requestId, p_paystack_reference: refund.refundReference });
    await logEvent(admin, { event_type: "refund_request_sent", reference: order.payment_reference, order_id: order.id, customer_id: order.customer_id, status: paidError ? "needs_attention" : "sent" });
    if (paidError) {
      // PayFast accepted the refund but saving it failed: say so clearly
      // so it gets followed up rather than refunded a second time.
      return json({ error: "The refund was sent to PayFast, but saving it failed. Please don't send it again; check PayFast before retrying." });
    }
    return json({ ok: true, request: paid });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Something went wrong." }, 500);
  }
});
