// ============================================================
// CLICKFUD — paystack-cancel-order Edge Function
//
// The only path that can move a customer's own order from 'received' to
// 'cancelled'. Handles two cases:
//   - COD (or any order that was never actually paid): free cancellation,
//     exactly as before — nothing was charged, nothing to refund.
//   - A paid "card" order: charges a cancellation fee (platform_config.
//     cancellation_fee_percent, default 20%) by refunding only the
//     remainder via a REAL Paystack refund against the order's own
//     payment_reference. The fee is never "collected" as a separate
//     transaction — it's simply the part of the original payment that
//     is not refunded.
//
// Idempotent: once an order's status is no longer 'received', a repeat
// call (double-click, retry) is rejected before ever touching Paystack
// again, so a customer can never be refunded twice for one order.
//
// Required secret: PAYSTACK_SECRET_KEY (TEST key, same as the other
// paystack-* functions).
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
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function round2(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return json({ error: "Please sign in." }, 401);

    const { orderId } = await req.json() as { orderId?: string };
    if (!orderId) return json({ error: "Missing order." });

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data: order } = await admin.from("orders").select("*").eq("id", orderId).single();
    if (!order) return json({ error: "Order not found." }, 404);
    if (order.customer_id !== userData.user.id) return json({ error: "This order does not belong to your account." }, 403);
    if (order.status !== "received") return json({ error: "This order can no longer be cancelled." });

    const historyEntry = (status: string) => ({ status, at: new Date().toISOString() });

    // ---- COD / never actually paid: free cancellation, unchanged behaviour ----
    if (order.payment_method !== "card" || order.payment_status !== "paid") {
      const history = [...(order.status_history || []), historyEntry("cancelled")];
      const { data: updated, error: updateError } = await admin.from("orders")
        .update({ status: "cancelled", status_history: history })
        .eq("id", orderId).eq("status", "received") // re-check status at write time too, closes a race with a second concurrent call
        .select().single();
      if (updateError || !updated) return json({ error: "This order can no longer be cancelled." });
      await admin.from("notifications").insert({
        user_id: order.customer_id, type: "order_cancelled",
        message: `Order ${order.order_number} was cancelled.`,
      });
      return json({ ok: true, order: updated, feeAmount: 0, refundAmount: 0 });
    }

    // ---- Paid card order: fee + real Paystack refund ----
    const { data: config } = await admin.from("platform_config").select("cancellation_fee_percent").eq("id", 1).single();
    const feePct = Number(config?.cancellation_fee_percent) ?? 20;
    const feeAmount = round2(Number(order.total) * (feePct / 100));
    const refundAmount = round2(Math.max(0, Number(order.total) - feeAmount));

    if (!order.payment_reference) {
      return json({ error: "This order has no payment reference on file — please contact support to cancel it." }, 500);
    }

    const refundRes = await fetch("https://api.paystack.co/refund", {
      method: "POST",
      headers: { Authorization: `Bearer ${paystackSecretKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        transaction: order.payment_reference,
        amount: Math.round(refundAmount * 100),
        currency: "ZAR",
        customer_note: `Order ${order.order_number} cancelled by customer.`,
        merchant_note: `Cancellation fee ${feePct}% (R${feeAmount.toFixed(2)}) retained; R${refundAmount.toFixed(2)} refunded.`,
      }),
    });
    const refundData = await refundRes.json();
    if (!refundRes.ok || !refundData.status) {
      // Nothing changes on our side if Paystack couldn't process the
      // refund — the order stays 'received' so the customer isn't left
      // thinking they cancelled something that was never actually refunded.
      return json({ error: refundData?.message || "Unable to process your refund right now. Please try again.", paystackStatus: refundRes.status });
    }

    const history = [...(order.status_history || []), historyEntry("cancelled")];
    const { data: updated, error: updateError } = await admin.from("orders")
      .update({
        status: "cancelled",
        status_history: history,
        payment_status: "refunded",
        cancellation_fee_amount: feeAmount,
        refund_amount: refundAmount,
        refunded_at: new Date().toISOString(),
        paystack_refund_reference: String(refundData.data?.id ?? refundData.data?.transaction_reference ?? order.payment_reference),
      })
      .eq("id", orderId).eq("status", "received")
      .select().single();
    if (updateError || !updated) {
      // The refund already succeeded on Paystack's side at this point —
      // surfaced clearly rather than silently reporting success, so this
      // gets followed up on rather than lost.
      return json({ error: `Your refund was processed by Paystack, but we couldn't update the order record. Please contact support with reference ${order.payment_reference}.` }, 500);
    }

    await admin.from("notifications").insert({
      user_id: order.customer_id, type: "order_cancelled",
      message: `Order ${order.order_number} was cancelled. A ${feePct}% cancellation fee (R${feeAmount.toFixed(2)}) applies — R${refundAmount.toFixed(2)} has been refunded to your original payment method.`,
    });

    return json({ ok: true, order: updated, feeAmount, refundAmount });
  } catch (e) {
    return json({ error: "Something went wrong cancelling your order." }, 500);
  }
});
