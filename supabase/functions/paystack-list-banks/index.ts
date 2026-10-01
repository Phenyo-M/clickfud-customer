// ============================================================
// CLICKFUD — paystack-list-banks Edge Function
//
// Paystack's own /bank endpoint requires the secret key, so the manager
// dashboard's "select your bank" dropdown can't call Paystack directly
// from the browser — this just proxies that one read-only lookup.
// Manager-only (any signed-in manager may list banks; this returns no
// shop-specific or sensitive data).
//
// Required secret: PAYSTACK_SECRET_KEY (same TEST key as the other
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return json({ error: "Please sign in." }, 401);

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data: profile } = await admin.from("profiles").select("role").eq("id", userData.user.id).single();
    if (!profile || profile.role !== "manager") return json({ error: "Only shop managers can do this." }, 403);

    // country alone is enough to filter to South African banks — adding a
    // currency filter on top is redundant for this endpoint (it's meant
    // for browsing which banks exist in a country, not for validating a
    // transaction currency) and was the actual cause of Paystack
    // rejecting the request with a currency-list error.
    const params = new URLSearchParams({ country: "south africa", perPage: "100" });
    const url = `https://api.paystack.co/bank?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${paystackSecretKey}` },
    });
    const data = await res.json();
    // Surface Paystack's own message verbatim rather than a generic one —
    // this is a live 3rd-party API call and the real reason it failed
    // (account/currency/country config, not necessarily our code) needs
    // to be visible to diagnose, not hidden behind "something went wrong".
    if (!res.ok || !data.status) {
      return json({ error: data?.message || "Unable to load bank list right now.", paystackStatus: res.status, paystackUrl: url }, 502);
    }

    const banks = (data.data || []).map((b: any) => ({ name: b.name, code: b.code }));
    return json({ banks });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong." }, 500);
  }
});
