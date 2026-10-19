// ============================================================
// CLICKFOOD — paystack-group-pay Edge Function
//
// "Everyone pays" group orders: starts a Paystack TEST-mode payment for the
// signed-in student's own share. The amount comes from group_order_shares,
// which the database worked out from the live menu when the leader locked
// the group; the browser only says which group. Nothing is marked paid here:
// paystack-verify / the signed webhook confirm the payment with Paystack and
// call finalize_paystack_checkout(), which updates the share and, once every
// share is paid, creates ONE combined order for the shop (group_payments.sql).
//
// Tapping Pay again never charges twice: a payment that is still open is
// re-used (same Paystack page), one Paystack already completed is applied,
// and claim_group_share_payment row-locks the share so two taps at once
// can't start two payments.
//
// Required secret: PAYSTACK_SECRET_KEY (a TEST key, sk_test_…).
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
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
async function logEvent(admin: SupabaseClient, row: Record<string, unknown>) {
  try { await admin.from("payment_events").insert({ source: "paystack-group-pay", ...row }); } catch (_e) { /* never fail over logging */ }
}
// Paystack answers that aren't final yet (same list as paystack-verify)
const NON_FINAL = ["ongoing", "pending", "processing", "queued", "abandoned", "send_birthday", "send_otp", "send_pin", "send_phone", "send_address", "open_url"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return json({ error: "Please sign in to pay." }, 401);
    const user = userData.user;

    const { groupId, callbackUrl } = await req.json() as { groupId?: string; callbackUrl?: string };
    if (!groupId || !callbackUrl) return json({ error: "Missing payment details." });

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data: share } = await admin.from("group_order_shares").select("*").eq("group_id", groupId).eq("user_id", user.id).maybeSingle();
    if (!share) return json({ error: "You have nothing to pay in this group." });
    if (share.status === "paid") return json({ ok: true, paid: true });

    // A payment already open for this share: finish it or re-use it, never start a second charge blindly.
    if (share.status === "processing" && share.reference) {
      const vr = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(share.reference)}`, { headers: { Authorization: `Bearer ${paystackSecretKey}` } });
      const vd = await vr.json().catch(() => ({}));
      const st = vd?.data?.status;
      if (vr.ok && vd.status && st === "success" && vd.data.amount === Math.round(Number(share.amount) * 100) && vd.data.currency === "ZAR") {
        await admin.rpc("finalize_paystack_checkout", { p_reference: share.reference });
        return json({ ok: true, paid: true });
      }
      const fresh = Date.now() - new Date(share.updated_at).getTime() < 30 * 60 * 1000;
      if (share.auth_url && fresh && (!st || NON_FINAL.includes(st))) {
        return json({ authorization_url: share.auth_url, reference: share.reference, reused: true });
      }
      if (st && !NON_FINAL.includes(st)) await admin.rpc("mark_paystack_checkout_failed", { p_reference: share.reference, p_reason: st });
    }

    const { data: profile } = await admin.from("profiles").select("email").eq("id", user.id).single();
    if (!profile?.email) return json({ error: "Your account has no email address." });

    const reference = "cfg_" + crypto.randomUUID().replace(/-/g, "");
    const { data: claim, error: claimError } = await admin.rpc("claim_group_share_payment", { p_group: groupId, p_user: user.id, p_reference: reference });
    if (claimError) return json({ error: "Could not start your payment. Please try again." }, 500);
    if (claim?.paid) return json({ ok: true, paid: true });
    if (!claim?.claimed) return json({ error: claim?.error || "Could not start your payment." });

    const amount = round2(claim.amount);
    const platformFee = round2(Math.min(Number(claim.platform_fee || 0), amount));
    const shopAmount = round2(amount - platformFee);
    const fail = async (reason: string, message: string, status = 502) => {
      await admin.from("checkout_sessions").update({ status: "failed", failure_reason: reason }).eq("reference", reference);
      await admin.from("group_order_shares").update({ status: "failed", failure_reason: reason, updated_at: new Date().toISOString() })
        .eq("group_id", groupId).eq("user_id", user.id).eq("reference", reference).eq("status", "processing");
      await logEvent(admin, { event_type: "group_pay_failed", reference, customer_id: user.id, status: "failed", failure_reason: reason });
      return json({ error: message }, status);
    };

    const { data: account } = await admin.from("store_payout_accounts").select("status,paystack_subaccount_code").eq("store_id", claim.store_id).maybeSingle();
    if (!account || account.status !== "active") {
      return await fail("shop_payouts_not_ready", "This shop hasn't set up online payments yet, so shares can't be paid online. Ask the leader to switch to \"leader pays\".", 200);
    }

    const { error: insertError } = await admin.from("checkout_sessions").insert({
      reference, customer_id: user.id, email: profile.email, currency: "ZAR", amount, status: "pending",
      group_id: groupId, share_user_id: user.id,
      groups: [{ storeId: claim.store_id, items: claim.items, subtotal: amount, platformFee, discount: 0, total: amount,
                 subaccountCode: account.paystack_subaccount_code, shopAmount, platformFeeAmount: platformFee,
                 deliveryLocation: { fulfilment: "collection", group_code: claim.code } }],
    });
    if (insertError) return await fail("session_insert_failed", "Could not start your payment. Please try again.", 500);

    // Same split as a normal order: the shop's subaccount gets its share, the platform keeps its per-item fee.
    let splitCode: string | null = null;
    if (shopAmount > 0) {
      const sr = await fetch("https://api.paystack.co/split", {
        method: "POST",
        headers: { Authorization: `Bearer ${paystackSecretKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: `clickfud-${reference}`, type: "flat", currency: "ZAR",
          subaccounts: [{ subaccount: account.paystack_subaccount_code, share: Math.round(shopAmount * 100) }], bearer_type: "all-proportional" }),
      });
      const sd = await sr.json().catch(() => ({}));
      if (!sr.ok || !sd.status) return await fail(sd?.message || "split_setup_failed", "Could not set up this payment. Please try again.");
      splitCode = sd.data.split_code;
    }

    const pr = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { Authorization: `Bearer ${paystackSecretKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: profile.email, amount: Math.round(amount * 100), currency: "ZAR", reference,
        callback_url: callbackUrl, split_code: splitCode || undefined, metadata: { customer_id: user.id, group_id: groupId } }),
    });
    const pd = await pr.json().catch(() => ({}));
    if (!pr.ok || !pd.status) return await fail(pd?.message || "initialize_api_failed", pd?.message || "Unable to start payment with Paystack.");

    await admin.rpc("set_share_auth_url", { p_group: groupId, p_user: user.id, p_reference: reference, p_url: pd.data.authorization_url });
    await logEvent(admin, { event_type: "group_pay_started", reference, customer_id: user.id, status: "pending" });
    return json({ authorization_url: pd.data.authorization_url, reference });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong starting your payment. Please try again." }, 500);
  }
});
