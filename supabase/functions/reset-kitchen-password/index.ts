// ============================================================
// CLICKFUD — reset-kitchen-password Edge Function
//
// Companion to create-kitchen-staff: since a shop's kitchen email is
// fixed (derived from the shop's own name, never manager-chosen — see
// create-kitchen-staff) and only one such account exists per shop, a
// forgotten password would otherwise permanently lock the kitchen out
// with no self-service recovery path (the account's email isn't a
// real inbox). This lets the shop's own manager set a new password for
// their store's existing kitchen account at any time.
//
// Required env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
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

    const { password } = await req.json() as { password?: string };
    if (!password || password.length < 8) return json({ error: "Password must be at least 8 characters." });

    const admin = createClient(supabaseUrl, serviceRoleKey);

    const { data: managerProfile } = await admin.from("profiles").select("role, store_id, active")
      .eq("id", userData.user.id).single();
    if (!managerProfile || managerProfile.role !== "manager" || !managerProfile.active || !managerProfile.store_id) {
      return json({ error: "Only a shop manager can reset their kitchen password." }, 403);
    }

    const { data: kitchenProfile } = await admin.from("profiles").select("id")
      .eq("store_id", managerProfile.store_id).eq("role", "kitchen").limit(1).maybeSingle();
    if (!kitchenProfile) return json({ error: "This shop doesn't have a kitchen account yet." }, 404);

    const { error: updateErr } = await admin.auth.admin.updateUserById(kitchenProfile.id, { password });
    if (updateErr) return json({ error: updateErr.message || "Could not update the password." }, 500);

    return json({ data: { ok: true } });
  } catch (e) {
    return json({ error: "Something went wrong resetting this password." }, 500);
  }
});
