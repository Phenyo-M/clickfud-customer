// ============================================================
// CLICKFOOD — refunds for group shares and second payments (shared by
// payfast-group-refund and payfast-itn)
//
// Refunds every payment that is due one:
//   * shares of a cancelled group (status refund_pending)
//   * an extra payment for a share that was already paid
//     (group_share_extra_payments)
//   * a second PayFast payment for an already paid checkout
//     (payment_duplicates)
// Each one is claimed first, so two calls at the same time can never
// refund the same payment twice.
//
// Live: sent through PayFast's refund API and marked refunded.
// Sandbox: PayFast's sandbox can't refund, so nothing is sent. The
// refund stays "due" and is marked "sandbox" so it isn't retried.
// ============================================================
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { refundPayfastPayment, refundPayment } from "./payfast.ts";

async function logEvent(admin: SupabaseClient, row: Record<string, unknown>) {
  try { await admin.from("payment_events").insert({ source: "group-refund", ...row }); } catch (_e) { /* never fail over logging */ }
}

async function refundOne(admin: SupabaseClient, reference: string, note: string) {
  const res = await refundPayment(admin, reference, null, note);
  if (res.ok) {
    await admin.rpc("mark_group_refund", { p_reference: reference, p_refund_reference: res.refundReference, p_status: "refunded" });
    await logEvent(admin, { event_type: "group_refund_sent", reference, status: "refunded" });
    return "sent";
  }
  if ("sandbox" in res && res.sandbox) {
    await admin.rpc("mark_group_refund", { p_reference: reference, p_refund_reference: "sandbox", p_status: "refund_pending" });
    await logEvent(admin, { event_type: "group_refund_recorded_sandbox", reference, status: "refund_pending" });
    return "recorded";
  }
  await admin.rpc("mark_group_refund", { p_reference: reference, p_refund_reference: null, p_status: "refund_failed" });
  await logEvent(admin, { event_type: "group_refund_failed", reference, status: "refund_failed", failure_reason: res.error });
  return "failed";
}

export async function refundGroupPayments(admin: SupabaseClient, opts: { groupId?: string | null; reference?: string | null }) {
  const claimedAt = "claimed:" + new Date().toISOString();
  const tally = { sent: 0, recorded: 0, failed: 0 };

  if (opts.groupId) {
    const { data: shares } = await admin.from("group_order_shares")
      .update({ refund_reference: claimedAt })
      .eq("group_id", opts.groupId).eq("status", "refund_pending").is("refund_reference", null)
      .select("paid_reference, group_id");
    for (const s of shares || []) {
      if (!s.paid_reference) continue;
      tally[await refundOne(admin, s.paid_reference, "Group order cancelled on ClickFood")]++;
    }
  }
  let extrasQuery = admin.from("group_share_extra_payments")
    .update({ refund_reference: claimedAt })
    .eq("status", "refund_pending").is("refund_reference", null);
  if (opts.reference) extrasQuery = extrasQuery.eq("reference", opts.reference);
  else if (opts.groupId) extrasQuery = extrasQuery.eq("group_id", opts.groupId);
  else return tally;
  const { data: extras } = await extrasQuery.select("reference");
  for (const x of extras || []) {
    tally[await refundOne(admin, x.reference, "Extra payment for a ClickFood group order")]++;
  }
  return tally;
}

// A second, separate PayFast payment for a checkout that was already paid.
export async function refundDuplicatePayment(admin: SupabaseClient, pfPaymentId: string) {
  const { data: dup } = await admin.from("payment_duplicates")
    .update({ refund_reference: "claimed:" + new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("provider_payment_id", pfPaymentId).eq("status", "refund_due").is("refund_reference", null)
    .select("*").maybeSingle();
  if (!dup) return "skipped";
  const res = await refundPayfastPayment(dup.environment, dup.provider_payment_id, Number(dup.amount), "Second payment for the same ClickFood order");
  if (res.ok) {
    await admin.from("payment_duplicates").update({ status: "refunded", refund_reference: res.refundReference, updated_at: new Date().toISOString() }).eq("provider_payment_id", pfPaymentId);
    await logEvent(admin, { event_type: "duplicate_refund_sent", reference: dup.reference, customer_id: dup.customer_id, status: "refunded" });
    return "sent";
  }
  if ("sandbox" in res && res.sandbox) {
    await admin.from("payment_duplicates").update({ refund_reference: "sandbox", updated_at: new Date().toISOString() }).eq("provider_payment_id", pfPaymentId);
    await logEvent(admin, { event_type: "duplicate_refund_recorded_sandbox", reference: dup.reference, customer_id: dup.customer_id, status: "refund_due" });
    return "recorded";
  }
  await admin.from("payment_duplicates").update({ status: "refund_failed", refund_reference: null, failure_reason: res.error, updated_at: new Date().toISOString() }).eq("provider_payment_id", pfPaymentId);
  await logEvent(admin, { event_type: "duplicate_refund_failed", reference: dup.reference, customer_id: dup.customer_id, status: "refund_failed", failure_reason: res.error });
  return "failed";
}
