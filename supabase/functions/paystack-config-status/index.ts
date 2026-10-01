// ============================================================
// CLICKFUD — paystack-config-status Edge Function
//
// Powers the Developer Dashboard's "Paystack Configuration" panel.
// Returns only safe, non-sensitive derived facts — never the secret
// key itself, not even a masked version of it. Developer-role only.
//
// What this CAN honestly report, and why:
//   - configured:  whether PAYSTACK_SECRET_KEY is set at all (a
//     boolean derived from Deno.env.get, never the value).
//   - mode:        'test' | 'live' | 'unknown', derived from the
//     key's own sk_test_/sk_live_ prefix — Paystack's own documented
//     key-naming convention, not a guess.
//   - currency:    hard-coded 'ZAR' — this app only ever initializes
//     ZAR transactions (see paystack-initialize/paystack-charge-saved).
//   - webhook signal: Paystack has no API endpoint to read back which
//     webhook URL is configured on an account (confirmed — there is
//     no such endpoint in Paystack's current documentation), so this
//     never claims to know that. Instead it reports the last time a
//     VALIDLY SIGNED webhook was actually received (from
//     payment_events, written by paystack-webhook itself) — real
//     evidence, not an assumption. If this is empty, the developer
//     still needs to confirm the webhook URL directly in Paystack's
//     dashboard (Settings -> API Keys & Webhooks).
//   - account verification status: Paystack does not expose KYC/
//     compliance status via API either — this links out to the
//     dashboard rather than inventing a status.
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const paystackSecretKey = Deno.env.get("PAYSTACK_SECRET_KEY") || "";

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

    const configured = paystackSecretKey.length > 0;
    const mode = paystackSecretKey.startsWith("sk_live_") ? "live" : paystackSecretKey.startsWith("sk_test_") ? "test" : "unknown";

    const { data: lastWebhook } = await admin.from("payment_events")
      .select("created_at").eq("source", "paystack-webhook")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count: webhookEvents24h } = await admin.from("payment_events")
      .select("id", { count: "exact", head: true }).eq("source", "paystack-webhook").gte("created_at", since24h);
    const { count: failedEvents24h } = await admin.from("payment_events")
      .select("id", { count: "exact", head: true }).not("failure_reason", "is", null).gte("created_at", since24h);

    return json({
      configured, mode, currency: "ZAR",
      webhookLastReceivedAt: lastWebhook?.created_at || null,
      webhookEvents24h: webhookEvents24h || 0,
      failedEvents24h: failedEvents24h || 0,
    });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong checking payment configuration." }, 500);
  }
});
