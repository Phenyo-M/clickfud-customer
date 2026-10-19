// ============================================================
// CLICKFOOD — payfast-config-status Edge Function
//
// Powers the Developer dashboard's payment panel. Developer-only. Returns
// safe facts only: never a merchant key or passphrase, not even masked.
//   configured / mode / problem: from the PayFast secrets (see
//     _shared/payfast.ts); "problem" says what is missing
//   liveAllowed: whether PAYFAST_ALLOW_LIVE is "yes"
//   notifyUrl: the address PayFast is told to send notifications to
//   lastItnAt / itn24h / failed24h: real evidence from payment_events
//   refundsDue: refunds recorded but not sent (sandbox, or older Paystack
//     test payments)
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { payfastConfig } from "../_shared/payfast.ts";

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

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data: profile } = await admin.from("profiles").select("role").eq("id", userData.user.id).single();
    if (!profile || profile.role !== "developer") return json({ error: "Developer access only." }, 403);

    const cfg = payfastConfig();
    const wanted = (Deno.env.get("PAYFAST_MODE") || "sandbox").trim().toLowerCase();
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [{ data: lastItn }, { count: itn24h }, { count: failed24h }, { count: ordersDue }, { count: dupDue }] = await Promise.all([
      admin.from("payment_events").select("created_at").eq("source", "payfast-itn").order("created_at", { ascending: false }).limit(1).maybeSingle(),
      admin.from("payment_events").select("id", { count: "exact", head: true }).eq("source", "payfast-itn").gte("created_at", since24h),
      admin.from("payment_events").select("id", { count: "exact", head: true }).not("failure_reason", "is", null).gte("created_at", since24h),
      admin.from("orders").select("id", { count: "exact", head: true }).eq("payment_status", "refund_pending").in("paystack_refund_reference", ["sandbox", "manual"]),
      admin.from("payment_duplicates").select("provider_payment_id", { count: "exact", head: true }).eq("status", "refund_due"),
    ]);

    return json({
      configured: !("error" in cfg),
      mode: "config" in cfg ? cfg.config.mode : wanted,
      problem: "error" in cfg ? cfg.error : null,
      liveAllowed: (Deno.env.get("PAYFAST_ALLOW_LIVE") || "").trim() === "yes",
      currency: "ZAR",
      notifyUrl: "config" in cfg ? cfg.config.notifyUrl : `${supabaseUrl}/functions/v1/payfast-itn`,
      lastItnAt: lastItn?.created_at || null,
      itn24h: itn24h || 0,
      failed24h: failed24h || 0,
      refundsDue: (ordersDue || 0) + (dupDue || 0),
    });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong checking payment configuration." }, 500);
  }
});
