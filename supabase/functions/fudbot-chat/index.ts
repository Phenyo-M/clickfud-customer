// ============================================================
// CLICKFUD — fudbot-chat Edge Function
//
// A real AI agent (Claude, tool-calling), not a hand-written if/regex
// intent matcher — every customer message goes through this function.
// The model itself decides what to look up or do, by calling tools;
// this file only ever executes those tools against REAL data (never
// fabricates a result) and never lets the model take an action outside
// the tool list below.
//
// Two request shapes:
//   1. A signed-in customer (real Supabase JWT) — full tool access:
//      real order lookups (via the CALLER's OWN JWT, so "orders
//      select" RLS still applies exactly as everywhere else in the
//      app — this can never return a different customer's orders no
//      matter what the message asks or claims), real menu/store/promo
//      search (public data, service-role client), and "action" tools
//      (cart/favorites/navigation) that this function does NOT execute
//      itself — cart and favorites are client-only (localStorage), so
//      those tool calls are returned to the browser as a small
//      structured instruction and js/fudbot.js runs the real
//      App.Store.addToCart()/etc. call, the exact same function every
//      other "Add" button in the app already uses.
//   2. No/invalid JWT (a logged-out visitor) — a much narrower guest
//      mode: no tools, no account/order data, just answers about how
//      clickFud/FudBot works and how to register or log in.
//
// Security (checked every request, never trusted from the client):
//   - A real Supabase JWT (if present) is verified via auth.getUser().
//   - The caller's role is looked up fresh from `profiles` via the
//     service-role client — never accepted as a claim in the request
//     body. Anything other than an active 'customer' account is
//     rejected outright, before any tool or AI call happens.
//   - Order lookups use a Supabase client carrying the CALLER's OWN
//     JWT, not the service-role client.
//   - The system prompt still tells the model never to reveal or
//     speculate about staff/manager/kitchen/developer data, other
//     customers' data, or internal system details — same rule the old
//     regex REFUSAL_PATTERN enforced, just as an instruction to a model
//     that can generalize it instead of a fixed keyword list. Real
//     enforcement is still the tool boundary above: there is no tool
//     here that can even reach any of that data.
//
// Required env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// (all provided automatically), plus ANTHROPIC_API_KEY (set yourself via
// `supabase secrets set`) and optionally ANTHROPIC_MODEL. Without
// ANTHROPIC_API_KEY this function responds with a clear "not
// configured" error rather than faking a reply.
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");
const anthropicModel = Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-4-5-20251001";
// Required as of Anthropic's newer API key model — an org-level key with
// no workspace-id header attached is rejected outright (confirmed via a
// live 400 from api.anthropic.com: "This API key is not scoped to a
// workspace..."). Not a secret (it's just an identifier), but still
// configurable via env rather than hardcoded so it can change without a
// code deploy.
const anthropicWorkspaceId = Deno.env.get("ANTHROPIC_WORKSPACE_ID");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const MAX_TOOL_ROUNDS = 4; // bounds cost/latency per message — plenty for "search menu, then add to cart"

// ---------------- Tool definitions (Anthropic tools schema) ----------------
// Read-only tools are executed here, server-side, against real data, and
// their real results are fed back to the model. "Action" tools are never
// executed here (cart/favorites live in the browser's localStorage, not
// the database) — the loop stops as soon as the model calls one, and
// it's returned to the client to actually perform.
const READ_TOOLS = [
  {
    name: "get_recent_orders",
    description: "Get this customer's own real recent orders (order number, status, total, store, date). Use for order history or 'what have I ordered before' questions.",
    input_schema: { type: "object", properties: { limit: { type: "integer", description: "Max orders to return, default 5" } } },
  },
  {
    name: "get_order_by_fragment",
    description: "Look up ONE of this customer's own real orders by any fragment of its order number. Use when they mention a specific order number, or to check the status of 'my order'/'my active order' if get_recent_orders hasn't already answered it.",
    input_schema: { type: "object", properties: { fragment: { type: "string", description: "Any part of the order number the customer gave" } }, required: ["fragment"] },
  },
  {
    name: "search_menu",
    description: "Search REAL, currently available menu items across every approved shop. Always call this before adding an item to the cart or answering a menu/price/ingredient question, so you have the real item id, price and details rather than guessing.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search against name/description/category" },
        category: { type: "string", enum: ["Breakfast", "Lunch", "Dinner", "Snacks", "Drinks", "Desserts", "Specials"] },
        max_price: { type: "number" },
        store_id: { type: "string", description: "Restrict to one shop's menu" },
      },
    },
  },
  {
    name: "list_stores",
    description: "List real, live shops on the platform (name, category, campus location, open/closed, rating). Use for 'what shops are there'/'which shops are open' questions.",
    input_schema: { type: "object", properties: { open_only: { type: "boolean" } } },
  },
  {
    name: "get_store_info",
    description: "Get real details (hours, location, category, rating, whether it's open) for one specific shop by name.",
    input_schema: { type: "object", properties: { store_name: { type: "string" } }, required: ["store_name"] },
  },
  {
    name: "list_promotions",
    description: "List real, currently active discount codes.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_account_info",
    description: "Get this customer's own real registered name, email and phone number.",
    input_schema: { type: "object", properties: {} },
  },
];

// Client-executed only — this function returns these as `action` in its
// response instead of running them. Every one mirrors a real function
// js/fudbot.js already had direct access to (App.Store.addToCart(),
// App.Store.setRoute(), etc.) — nothing new is invented here, it's the
// same underlying operations, just requested by the model instead of a
// regex match.
const ACTION_TOOLS = [
  {
    name: "cart_add",
    description: "Add a real menu item to the customer's cart. You MUST call search_menu first to get its real item_id, name and price — never guess these.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "string" }, name: { type: "string" }, price: { type: "number" },
        store_id: { type: "string" }, store_name: { type: "string" }, quantity: { type: "integer" },
      },
      required: ["item_id", "name", "price", "store_id", "quantity"],
    },
  },
  {
    name: "cart_remove",
    description: "Remove an item from the cart by name (matched against the customer's current cart given to you in context).",
    input_schema: { type: "object", properties: { item_name: { type: "string" } }, required: ["item_name"] },
  },
  {
    name: "cart_update_quantity",
    description: "Change the quantity of an item already in the cart.",
    input_schema: { type: "object", properties: { item_name: { type: "string" }, quantity: { type: "integer" } }, required: ["item_name", "quantity"] },
  },
  { name: "cart_clear", description: "Empty the entire cart.", input_schema: { type: "object", properties: {} } },
  {
    name: "favorite_add",
    description: "Save a real menu item to favorites. Call search_menu first for its real item_id.",
    input_schema: { type: "object", properties: { item_id: { type: "string" }, name: { type: "string" } }, required: ["item_id", "name"] },
  },
  {
    name: "favorite_remove",
    description: "Remove an item from favorites by name.",
    input_schema: { type: "object", properties: { item_name: { type: "string" } }, required: ["item_name"] },
  },
  {
    name: "navigate",
    description: "Take the customer to a real page in the app.",
    input_schema: { type: "object", properties: { destination: { type: "string", enum: ["cart", "profile", "checkout", "orders", "home", "favorites"] } }, required: ["destination"] },
  },
];
const ACTION_TOOL_NAMES = new Set(ACTION_TOOLS.map((t) => t.name));

const CUSTOMER_SYSTEM_PROMPT = `You are FudBot, the official customer assistant for clickFud, a campus food-ordering app. You are talking to a real, signed-in customer.

Scope: order status/tracking/history, cart, favorites, menu/shop questions, and how ordering/pickup/payment/cancellation work on clickFud. You may take real actions (add/remove cart items, favorite items, navigate) using the tools provided — always call search_menu first to get a real item's id before adding it to the cart or favorites, never invent an id, price or name.

Never reveal, discuss or speculate about: manager/staff/kitchen/developer accounts, suppliers, inventory, shop financials/analytics, API keys, credentials, environment variables, internal system/database structure, or any other customer's data. If asked, reply with exactly: "Sorry, I can only help you with your customer account and orders." and take no tool action.

Only ever state facts you got from a tool call or from the context given to you below (current cart, current favorites, the shop currently being viewed). If you don't have real information to answer something, say so plainly rather than guessing — never invent a price, order status, delivery time, product, discount or policy.

clickFud is collection only — customers order online then pick up in person; there is no delivery yet. Payment is Cash (on collection) or Card via Paystack. Cancellation is available while an order is still active from the Track Order page; a cancellation fee may apply for card payments, cash has none.

Be short, clear, friendly and professional — not excessively chatty. If asked something unrelated to clickFud ordering, redirect: "I can help with your clickFud order, menu, cart, and account. What would you like help with?"`;

const GUEST_SYSTEM_PROMPT = `You are FudBot, the official assistant for clickFud, a campus food-ordering app, talking to a visitor who is NOT signed in yet and has no account or order data.

You have no tools and no account/order/cart access — you cannot look anything up. You may only: explain what clickFud/FudBot is, explain how to register (tap Profile in the bottom bar, then Sign Up — name, email, password) or log in (tap Profile, then Log In), and answer brief general questions about how ordering works (collection only, pay by cash on collection or card via Paystack online).

If asked about an order, cart, menu specifics, account details, or anything requiring a real account, reply: "Please log in first to ask about that. Right here I can only help with creating an account, logging in, or general questions about FudBot." Never reveal or speculate about staff/manager/kitchen/developer/internal system data.

Be short, warm and professional.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!anthropicApiKey) return json({ error: "not_configured" });

    const body = await req.json().catch(() => ({})) as {
      message?: string;
      history?: { role: "user" | "assistant"; content: string }[];
      cart?: { name: string; qty: number; price: number }[];
      favoriteNames?: string[];
      currentStoreName?: string;
    };
    const message = (body.message || "").trim();
    if (!message) return json({ error: "Message is required." });
    const history = Array.isArray(body.history) ? body.history.slice(-10) : [];

    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData } = await userClient.auth.getUser();
    const admin = createClient(supabaseUrl, serviceRoleKey);

    let profile: { id: string; role: string; active: boolean; name?: string; email?: string; phone?: string } | null = null;
    if (userData?.user) {
      const { data } = await admin.from("profiles").select("id, role, active, name, email, phone").eq("id", userData.user.id).single();
      profile = data || null;
    }

    // ---------------- Guest path: no tools, no data, a much smaller model call ----------------
    if (!profile || profile.role !== "customer" || !profile.active) {
      const reply = await callClaude({
        system: GUEST_SYSTEM_PROMPT,
        messages: [...historyToMessages(history), { role: "user", content: message }],
      });
      if (reply.error) return json({ error: reply.error });
      return json({ data: { reply: reply.text } });
    }

    // ---------------- Signed-in customer path: real tool-calling agent loop ----------------
    const contextLines = [
      body.cart && body.cart.length
        ? `Customer's current cart: ${body.cart.map((c) => `${c.qty}x ${c.name} (R${c.price} each)`).join(", ")}`
        : "Customer's current cart: empty.",
      body.favoriteNames && body.favoriteNames.length
        ? `Customer's current favorites: ${body.favoriteNames.join(", ")}`
        : "Customer's current favorites: none.",
      body.currentStoreName ? `Shop the customer is currently viewing: ${body.currentStoreName}` : "Customer is not currently viewing any specific shop.",
    ].join("\n");

    const messages: { role: "user" | "assistant"; content: unknown }[] = [
      ...historyToMessages(history),
      { role: "user", content: `${message}\n\n[Context — not something the customer typed:\n${contextLines}]` },
    ];

    let pendingAction: { type: string; params: Record<string, unknown> } | null = null;
    let finalText = "";

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await callClaudeRaw({
        system: CUSTOMER_SYSTEM_PROMPT,
        messages,
        tools: [...READ_TOOLS, ...ACTION_TOOLS],
      });
      if (res.error) return json({ error: res.error });

      const toolUseBlocks = (res.content || []).filter((b: any) => b.type === "tool_use");
      const textBlocks = (res.content || []).filter((b: any) => b.type === "text");
      finalText = textBlocks.map((b: any) => b.text).join("\n").trim() || finalText;

      if (!toolUseBlocks.length) break; // model is done — plain text answer

      messages.push({ role: "assistant", content: res.content });

      // An action tool ends the loop immediately — this function has no
      // way to execute it (cart/favorites/navigation are client-side),
      // so there's nothing real to feed back as a tool_result.
      const actionBlock = toolUseBlocks.find((b: any) => ACTION_TOOL_NAMES.has(b.name));
      if (actionBlock) {
        pendingAction = { type: actionBlock.name, params: actionBlock.input || {} };
        break;
      }

      // Read tools — execute for real, feed real results back, let the
      // model continue (it may call another tool, or answer).
      const toolResults = await Promise.all(toolUseBlocks.map(async (b: any) => ({
        type: "tool_result",
        tool_use_id: b.id,
        content: JSON.stringify(await runReadTool(b.name, b.input || {}, { userClient, admin, customerId: profile!.id, profile })),
      })));
      messages.push({ role: "user", content: toolResults });
    }

    if (!finalText && !pendingAction) finalText = "I don't have that information available right now.";
    return json({ data: { reply: finalText || "Done!", action: pendingAction || undefined } });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong." }, 500);
  }
});

function historyToMessages(history: { role: "user" | "assistant"; content: string }[]) {
  return history.map((h) => ({ role: h.role, content: h.content }));
}

// ---------------- Real, read-only tool execution (service-role for public
// tables, caller's own JWT for orders so RLS still scopes it to their own
// rows) ----------------
async function runReadTool(name: string, input: any, ctx: { userClient: any; admin: any; customerId: string; profile: any }) {
  const { userClient, admin } = ctx;
  if (name === "get_recent_orders") {
    const limit = Math.min(Number(input.limit) || 5, 20);
    const { data, error } = await userClient.from("orders").select("order_number, status, total, created_at, store_id").order("created_at", { ascending: false }).limit(limit);
    if (error) return { error: error.message };
    const storeIds = [...new Set((data || []).map((o: any) => o.store_id).filter(Boolean))];
    const stores = storeIds.length ? (await admin.from("stores").select("id, name").in("id", storeIds)).data || [] : [];
    const storeName = (id: string) => stores.find((s: any) => s.id === id)?.name;
    return { orders: (data || []).map((o: any) => ({ order_number: o.order_number, status: o.status, total: o.total, created_at: o.created_at, store: storeName(o.store_id) })) };
  }
  if (name === "get_order_by_fragment") {
    const clean = String(input.fragment || "").toUpperCase().replace(/[^A-Z0-9-]/g, "");
    if (!clean) return { error: "No order number given." };
    const { data, error } = await userClient.from("orders").select("order_number, status, total, created_at, store_id").order("created_at", { ascending: false }).limit(50);
    if (error) return { error: error.message };
    const match = (data || []).find((o: any) => o.order_number && o.order_number.toUpperCase().replace(/[^A-Z0-9-]/g, "").includes(clean));
    if (!match) return { found: false };
    const store = match.store_id ? (await admin.from("stores").select("name").eq("id", match.store_id).single()).data : null;
    return { found: true, order: { order_number: match.order_number, status: match.status, total: match.total, created_at: match.created_at, store: store?.name } };
  }
  if (name === "search_menu") {
    let q = admin.from("menu_items").select("id, name, price, category, description, ingredients, allergens, preparation_time, store_id, stock, available").eq("status", "approved").eq("available", true).gt("stock", 0).limit(15);
    if (input.query) q = q.or(`name.ilike.%${input.query}%,description.ilike.%${input.query}%`);
    if (input.category) q = q.eq("category", input.category);
    if (input.max_price != null) q = q.lte("price", Number(input.max_price));
    if (input.store_id) q = q.eq("store_id", input.store_id);
    const { data, error } = await q;
    if (error) return { error: error.message };
    const storeIds = [...new Set((data || []).map((m: any) => m.store_id).filter(Boolean))];
    const stores = storeIds.length ? (await admin.from("stores").select("id, name, status, is_published").in("id", storeIds)).data || [] : [];
    const liveStoreIds = new Set(stores.filter((s: any) => s.status === "approved" && s.is_published).map((s: any) => s.id));
    const storeName = (id: string) => stores.find((s: any) => s.id === id)?.name;
    return { items: (data || []).filter((m: any) => liveStoreIds.has(m.store_id)).map((m: any) => ({ id: m.id, name: m.name, price: m.price, category: m.category, description: m.description, ingredients: m.ingredients, allergens: m.allergens, preparation_time_minutes: m.preparation_time, store_id: m.store_id, store: storeName(m.store_id) })) };
  }
  if (name === "list_stores") {
    const { data, error } = await admin.from("stores").select("id, name, category, campus_location, opening_time, closing_time, rating, rating_count").eq("status", "approved").eq("is_published", true).order("name");
    if (error) return { error: error.message };
    return { stores: (data || []).map((s: any) => ({ id: s.id, name: s.name, category: s.category, campus_location: s.campus_location, opening_time: s.opening_time, closing_time: s.closing_time, rating: s.rating, rating_count: s.rating_count })) };
  }
  if (name === "get_store_info") {
    const { data, error } = await admin.from("stores").select("id, name, category, campus_location, opening_time, closing_time, rating, rating_count, accepts_collection").eq("status", "approved").eq("is_published", true).ilike("name", `%${input.store_name || ""}%`).limit(1).single();
    if (error || !data) return { found: false };
    return { found: true, store: data };
  }
  if (name === "list_promotions") {
    const { data, error } = await admin.from("promotions").select("code, type, value, active, expires_at").eq("active", true);
    if (error) return { error: error.message };
    const now = new Date();
    return { promotions: (data || []).filter((p: any) => !p.expires_at || new Date(p.expires_at) > now).map((p: any) => ({ code: p.code, type: p.type, value: p.value })) };
  }
  if (name === "get_account_info") {
    return { name: ctx.profile?.name, email: ctx.profile?.email, phone: ctx.profile?.phone };
  }
  return { error: "Unknown tool." };
}

// ---------------- Anthropic API calls ----------------
async function callClaudeRaw(opts: { system: string; messages: unknown[]; tools?: unknown[] }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicApiKey!, "anthropic-version": "2023-06-01", "content-type": "application/json",
      ...(anthropicWorkspaceId ? { "anthropic-workspace-id": anthropicWorkspaceId } : {}),
    },
    body: JSON.stringify({ model: anthropicModel, max_tokens: 600, system: opts.system, messages: opts.messages, tools: opts.tools }),
  });
  if (!res.ok) {
    console.error("Anthropic API error", res.status, await res.text());
    return { error: "AI is temporarily unavailable." };
  }
  return await res.json();
}
async function callClaude(opts: { system: string; messages: unknown[] }) {
  const data = await callClaudeRaw(opts);
  if ((data as any).error) return { error: (data as any).error };
  const text = ((data as any).content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
  if (!text) return { error: "AI returned an empty response." };
  return { text };
}
