// ============================================================
// CLICKFOOD — paystack-group-refund Edge Function
//
// The group leader (or a developer) asks for the refunds a cancelled
// "everyone pays" group is due. Only payments the database already marked
// as due a refund are touched (see group_payments.sql); each is claimed
// before Paystack is asked, so it can never be refunded twice.
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { refundGroupPayments } from "../_shared/group-refund.ts";

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

    const { groupId, retryFailed } = await req.json() as { groupId?: string; retryFailed?: boolean };
    if (!groupId) return json({ error: "Missing group." });

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const [{ data: group }, { data: profile }] = await Promise.all([
      admin.from("group_orders").select("id, leader_id, status").eq("id", groupId).maybeSingle(),
      admin.from("profiles").select("role").eq("id", userData.user.id).single(),
    ]);
    if (!group) return json({ error: "Group order not found." }, 404);
    if (group.leader_id !== userData.user.id && profile?.role !== "developer") return json({ error: "Only the group leader can do this." }, 403);
    if (group.status !== "cancelled") return json({ error: "Refunds are only for cancelled group orders." });

    if (retryFailed) {
      await admin.from("group_order_shares").update({ status: "refund_pending", refund_reference: null })
        .eq("group_id", groupId).eq("status", "refund_failed");
      await admin.from("group_share_extra_payments").update({ status: "refund_pending", refund_reference: null })
        .eq("group_id", groupId).eq("status", "refund_failed");
    }
    const result = await refundGroupPayments(admin, paystackSecretKey, { groupId });
    return json({ ok: true, ...result });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong with the refunds. Please try again." }, 500);
  }
});
