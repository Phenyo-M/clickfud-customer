// ============================================================
// CLICKFUD — fudbot-chat Edge Function
//
// The ONLY server-side piece of FudBot (js/fudbot.js handles order
// status/cart/menu lookups entirely client-side against data RLS
// already scoped to the caller) — this function exists purely so the
// AI API key never has to live in frontend code, and so free-text
// questions that don't match a known intent can still get a real,
// grounded answer instead of a canned redirect.
//
// Security (checked every request, never trusted from the client):
//   1. A real Supabase JWT must be present — auth.getUser() verifies it.
//   2. The caller's role is looked up fresh from `profiles` via the
//      service-role client — never accepted as a claim in the request
//      body. Anything other than an active 'customer' account is
//      rejected outright, before any AI call or data fetch happens.
//   3. Order data used to ground the AI's answer is fetched with a
//      Supabase client carrying the CALLER's OWN JWT (userClient), not
//      the service-role client — meaning normal "orders select" RLS
//      still applies here exactly as it does everywhere else in the
//      app, so this can never return a different customer's orders no
//      matter what the message asks or claims.
//
// Required env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// (all provided automatically), plus ANTHROPIC_API_KEY (set yourself via
// `supabase secrets set`) and optionally ANTHROPIC_MODEL. Without
// ANTHROPIC_API_KEY this function responds with a clear "not
// configured" error rather than faking an AI reply.
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");
const anthropicModel = Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-4-5-20251001";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const SYSTEM_PROMPT = `You are FudBot, the official customer assistant for clickFud, a campus food-ordering app.

You may only help with: order status/tracking, order history, cart questions, menu questions (using only the real data given to you), and explaining how ordering, pickup and delivery work on clickFud.

You must NEVER reveal, discuss or speculate about: manager/staff/kitchen/developer accounts or information, suppliers, inventory, restaurant financials or analytics, API keys, credentials, environment variables, internal system/database structure, or any other customer's data. If asked about any of this, reply with exactly: "Sorry, I can only help you with your customer account and orders."

Never invent an order status, price, delivery time, product, discount or policy. Only use the real order data provided to you below. If you don't have the real information to answer something, say exactly: "I don't have that information available right now."

Be short, clear, friendly and professional — not excessively chatty. If the question is unrelated to clickFud ordering, redirect with: "I can help with your clickFud order, menu, cart, and account. What would you like help with?"`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return json({ error: "Please sign in." }, 401);

    const { message } = await req.json() as { message?: string };
    if (!message || typeof message !== "string" || !message.trim()) return json({ error: "Message is required." });

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data: profile } = await admin.from("profiles").select("id, role, active").eq("id", userData.user.id).single();
    if (!profile || profile.role !== "customer" || !profile.active) {
      return json({ error: "FudBot is only available to customer accounts." }, 403);
    }

    if (!anthropicApiKey) return json({ error: "not_configured" });

    // userClient, not admin — RLS still applies, so this is only ever
    // this one customer's own orders, exactly as if the app itself had
    // fetched them.
    const { data: orders } = await userClient.from("orders")
      .select("order_number, status, total, created_at")
      .order("created_at", { ascending: false })
      .limit(5);

    const ordersSummary = (orders && orders.length)
      ? orders.map((o: any) => `Order ${o.order_number}: status=${o.status}, total=R${o.total}, placed=${o.created_at}`).join("\n")
      : "This customer has no orders yet.";

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": anthropicApiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: anthropicModel,
        max_tokens: 400,
        system: `${SYSTEM_PROMPT}\n\nThis customer's real recent orders (only these — never assume any other order exists):\n${ordersSummary}`,
        messages: [{ role: "user", content: message.slice(0, 1000) }],
      }),
    });
    if (!aiRes.ok) {
      console.error("Anthropic API error", aiRes.status, await aiRes.text());
      return json({ error: "AI is temporarily unavailable." });
    }
    const aiData = await aiRes.json();
    const reply = aiData?.content?.[0]?.text;
    if (!reply) return json({ error: "AI returned an empty response." });

    return json({ data: { reply } });
  } catch (e) {
    return json({ error: "Something went wrong." }, 500);
  }
});
