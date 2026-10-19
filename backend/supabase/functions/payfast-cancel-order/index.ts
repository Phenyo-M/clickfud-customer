// ============================================================
// CLICKFOOD — payfast-cancel-order Edge Function
//
// The only path that can move a customer's own order from 'received' OR
// 'preparing' to 'cancelled'. Two cases:
//   - Cash (or never actually paid): free cancellation, nothing to refund.
//   - A paid card order: a cancellation fee (platform_config.
//     cancellation_fee_percent, default 20%) is kept and the rest is
//     refunded through PayFast. In sandbox (and for older Paystack test
//     payments) nothing can be sent, so the refund is recorded as due
//     (payment_status 'refund_pending').
//
// Idempotent: the status is re-checked when the order is written, so a
// double tap can never refund twice.
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

function round2(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function logEvent(admin: SupabaseClient, row: {
  event_type: string; reference?: string | null; order_id?: string | null; customer_id?: string | null; status?: string | null; failure_reason?: string | null;
}) {
  try { await admin.from("payment_events").insert({ source: "payfast-cancel-order", ...row }); } catch (_e) { /* never fail cancellation over a logging error */ }
}

// The shop hears that (and why) a customer cancelled from the notification
// queue: the orders trigger sees cancel_reason customer_cancelled and reads
// the reason from cancel_note (supabase/notification_queue.sql).

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return json({ error: "Please sign in." }, 401);

    const { orderId, reason, note } = await req.json() as { orderId?: string; reason?: string; note?: string };
    // Why the customer cancelled (asked in the app). Older app versions send
    // no reason; that is recorded as "No reason given" rather than refused.
    const REASONS: Record<string, string> = {
      item_unavailable: "The seller doesn't have what I ordered",
      too_slow: "It's taking too long",
      cant_collect: "I can't collect at the chosen time",
      by_mistake: "I ordered by mistake",
      change_order: "I want to change my order",
      found_elsewhere: "I found food somewhere else",
      too_expensive: "It's too expensive",
      seller_problem: "A problem with the seller",
      other: "Other",
    };
    const reasonLabel = reason && REASONS[reason] ? REASONS[reason] : "No reason given";
    const noteText = String(note || "").trim().slice(0, 200);
    if (reason === "other" && !noteText) return json({ error: "Please tell us why you are cancelling." });
    const cancelNote = ("Customer: " + reasonLabel + (noteText ? " (" + noteText + ")" : "")).slice(0, 200);
    if (!orderId) return json({ error: "Missing order." });

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data: order } = await admin.from("orders").select("*").eq("id", orderId).single();
    if (!order) return json({ error: "Order not found." }, 404);
    if (order.customer_id !== userData.user.id) return json({ error: "This order does not belong to your account." }, 403);
    if (order.delivery_location && order.delivery_location.group_pay === "each") {
      return json({ error: "This group order was paid by several people, so it can't be refunded here. Please contact ClickFood support." });
    }
    const CANCELLABLE_STATUSES = ["received", "preparing"];
    if (!CANCELLABLE_STATUSES.includes(order.status)) return json({ error: "This order can no longer be cancelled." });

    const historyEntry = (status: string) => ({ status, at: new Date().toISOString() });

    // ---- Cash / never actually paid: free cancellation ----
    if (order.payment_method !== "card" || order.payment_status !== "paid") {
      const history = [...(order.status_history || []), historyEntry("cancelled")];
      const { data: updated, error: updateError } = await admin.from("orders")
        .update({ status: "cancelled", status_history: history, cancel_reason: "customer_cancelled", cancel_note: cancelNote })
        .eq("id", orderId).in("status", CANCELLABLE_STATUSES)
        .select().single();
      if (updateError || !updated) return json({ error: "This order can no longer be cancelled." });
      await admin.from("notifications").insert({
        user_id: order.customer_id, type: "order_cancelled",
        message: `Order ${order.order_number} was cancelled.`,
      });
      return json({ ok: true, order: updated, feeAmount: 0, refundAmount: 0 });
    }

    // ---- Paid card order: fee + refund ----
    const { data: config } = await admin.from("platform_config").select("cancellation_fee_percent").eq("id", 1).single();
    const feePct = config?.cancellation_fee_percent == null ? 20 : Number(config.cancellation_fee_percent);
    const feeAmount = round2(Number(order.total) * (feePct / 100));
    const refundAmount = round2(Math.max(0, Number(order.total) - feeAmount));

    if (!order.payment_reference) {
      return json({ error: "This order has no payment reference on file. Please contact support to cancel it." }, 500);
    }

    // Claim the order first (status re-checked at write time), so two
    // taps can't both send a refund.
    const history = [...(order.status_history || []), historyEntry("cancelled")];
    const { data: claimed } = await admin.from("orders")
      .update({ status: "cancelled", status_history: history, cancel_reason: "customer_cancelled", cancel_note: cancelNote,
                payment_status: "refund_pending", cancellation_fee_amount: feeAmount, refund_amount: refundAmount })
      .eq("id", orderId).in("status", CANCELLABLE_STATUSES).eq("payment_status", "paid")
      .select().single();
    if (!claimed) return json({ error: "This order can no longer be cancelled." });

    const refund = refundAmount > 0
      ? await refundPayment(admin, order.payment_reference, refundAmount, `Order ${order.order_number} cancelled by customer`)
      : { ok: true as const, refundReference: "nothing_to_refund" };

    if (!refund.ok && !("sandbox" in refund && refund.sandbox) && !("legacy" in refund && refund.legacy)) {
      // PayFast refused: put the order back exactly as it was.
      await admin.from("orders").update({
        status: order.status, status_history: order.status_history, cancel_reason: order.cancel_reason,
        payment_status: "paid", cancellation_fee_amount: order.cancellation_fee_amount, refund_amount: order.refund_amount,
      }).eq("id", orderId);
      await logEvent(admin, { event_type: "refund_failed", order_id: order.id, customer_id: order.customer_id, status: "failed", failure_reason: refund.error });
      return json({ error: "We couldn't refund this order right now, so it wasn't cancelled. Please try again." });
    }

    const recordedOnly = !refund.ok;
    const { data: updated } = await admin.from("orders")
      .update({
        payment_status: recordedOnly ? "refund_pending" : "refunded",
        refunded_at: recordedOnly ? null : new Date().toISOString(),
        paystack_refund_reference: refund.ok ? refund.refundReference : ("sandbox" in refund && refund.sandbox ? "sandbox" : "manual"),
      })
      .eq("id", orderId).select().single();
    await logEvent(admin, {
      event_type: recordedOnly ? "refund_recorded" : "refund_sent", reference: order.payment_reference,
      order_id: order.id, customer_id: order.customer_id, status: recordedOnly ? "refund_pending" : "refunded",
      failure_reason: recordedOnly ? refund.error : null,
    });

    await admin.from("notifications").insert({
      user_id: order.customer_id, type: "order_cancelled",
      message: `Order ${order.order_number} was cancelled. A ${feePct}% cancellation fee (R${feeAmount.toFixed(2)}) applies. R${refundAmount.toFixed(2)} ${recordedOnly ? "will be refunded" : "is being refunded to your card"}.`,
    });

    return json({ ok: true, order: updated || claimed, feeAmount, refundAmount, refundRecordedOnly: recordedOnly });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong cancelling your order." }, 500);
  }
});
