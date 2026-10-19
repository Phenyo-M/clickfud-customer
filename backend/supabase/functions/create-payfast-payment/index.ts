// ============================================================
// CLICKFOOD — create-payfast-payment Edge Function
//
// Starts a PayFast payment for either:
//   * the customer's cart: { groups, promoCode, returnUrl }
//   * their share of an "everyone pays" group order: { groupId, returnUrl }
//
// The browser only says WHICH items (or which group); every price is
// worked out here from the live menu, the same way the database's
// validate_order_pricing trigger does. No order exists yet: a
// checkout_sessions row is saved, and the order is only created once
// PayFast's notification (payfast-itn) has been verified on the server.
//
// Returns signed checkout fields for PayFast's payment page. They hold no
// secret: the passphrase is only hashed into the signature.
//
// Repeated taps never start a second payment for the same thing: an
// open payment (same customer, same cart, last 30 minutes) is reused,
// and a group share that is already being paid reuses its payment.
//
// Secrets: see supabase/functions/_shared/payfast.ts.
// ============================================================
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { clientKey, limited } from "../_shared/limit.ts";
import { allowedReturnUrl, payfastConfig, sha256Hex, signedCheckout, withParams, type PayfastConfig } from "../_shared/payfast.ts";

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

function round2(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

const REUSE_MINUTES = 30;

async function logEvent(admin: SupabaseClient, row: {
  event_type: string; reference?: string | null; customer_id?: string | null; status?: string | null; failure_reason?: string | null;
}) {
  try { await admin.from("payment_events").insert({ source: "create-payfast-payment", ...row }); } catch (_e) { /* never fail the payment over a logging error */ }
}

interface ExtraSelectionInput { id: string; name?: string; price?: number }
interface CartItemInput {
  menuItemId: string; qty: number; isAddon?: boolean; addons?: ExtraSelectionInput[]; specialInstructions?: string;
}
interface GroupInput { storeId: string; items: CartItemInput[]; deliveryLocation: Record<string, unknown> }

async function checkoutResponse(config: PayfastConfig, opts: {
  reference: string; amount: number; email: string; itemName: string; itemDescription: string; returnUrl: string; reused?: boolean;
}) {
  const signed = await signedCheckout(config, {
    reference: opts.reference,
    amount: opts.amount,
    email: opts.email,
    itemName: opts.itemName,
    itemDescription: opts.itemDescription,
    returnUrl: withParams(opts.returnUrl, { reference: opts.reference }),
    cancelUrl: withParams(opts.returnUrl, { reference: opts.reference, payment: "cancelled" }),
  });
  return {
    processUrl: config.processUrl, fields: signed.fields, url: signed.url,
    reference: opts.reference, mode: config.mode, reused: !!opts.reused,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return json({ error: "Please sign in to pay online." }, 401);
    const user = userData.user;
    {
      const limiter = createClient(supabaseUrl, serviceRoleKey);
      const tooMany = (await limited(limiter, "acct:" + user.id, "payment_start", 10, 600, corsHeaders, "Too many payment attempts. Please wait a few minutes."))
        || (await limited(limiter, await clientKey(req), "payment_start_ip", 30, 600, corsHeaders, "Too many payment attempts. Please wait a few minutes."));
      if (tooMany) return tooMany;
      // the developer can switch online payment off (developer app, Payments);
      // checked here so no app version can start a payment while it is off
      const { data: pc } = await limiter.from("platform_config").select("online_payments_enabled").eq("id", 1).maybeSingle();
      if (pc && pc.online_payments_enabled === false) {
        return json({ error: "Online payment is switched off for now. Please choose Cash on Collection." });
      }
    }

    const cfg = payfastConfig();
    if ("error" in cfg) {
      console.error("PayFast not configured:", cfg.error);
      return json({ error: "Online payment isn't available right now. Please pay with cash." });
    }
    const config = cfg.config;

    const body = await req.json() as { groups?: GroupInput[]; promoCode?: string | null; returnUrl?: string; groupId?: string };
    const returnUrl = String(body.returnUrl || "");
    if (!allowedReturnUrl(returnUrl)) return json({ error: "Invalid return address." });

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data: profile } = await admin.from("profiles").select("id,email,name").eq("id", user.id).single();
    if (!profile) return json({ error: "Profile not found." }, 404);

    // ================= group share =================
    if (body.groupId) {
      const groupId = body.groupId;
      const { data: share } = await admin.from("group_order_shares").select("*").eq("group_id", groupId).eq("user_id", user.id).maybeSingle();
      if (!share) return json({ error: "You have nothing to pay in this group." });
      if (share.status === "paid") return json({ ok: true, paid: true });

      // Already being paid: reopen the SAME payment, never a second one.
      const fresh = Date.now() - new Date(share.updated_at).getTime() < REUSE_MINUTES * 60 * 1000;
      if (share.status === "processing" && share.reference && share.auth_url && fresh) {
        const { data: open } = await admin.from("checkout_sessions").select("status, environment, amount").eq("reference", share.reference).maybeSingle();
        if (open && open.status === "pending" && open.environment === config.mode) {
          const { data: g } = await admin.from("group_orders").select("code").eq("id", groupId).maybeSingle();
          return json(await checkoutResponse(config, {
            reference: share.reference, amount: Number(open.amount), email: profile.email,
            itemName: `ClickFood group order ${g?.code || ""}`, itemDescription: "Your share", returnUrl, reused: true,
          }));
        }
      }

      const reference = "cfg_" + crypto.randomUUID().replace(/-/g, "");
      const { data: claim, error: claimError } = await admin.rpc("claim_group_share_payment", { p_group: groupId, p_user: user.id, p_reference: reference });
      if (claimError) return json({ error: "Could not start your payment. Please try again." }, 500);
      if (claim?.paid) return json({ ok: true, paid: true });
      if (!claim?.claimed) return json({ error: claim?.error || "Could not start your payment." });

      const amount = round2(claim.amount);
      const platformFee = round2(Math.min(Number(claim.platform_fee || 0), amount));
      const shopAmount = round2(amount - platformFee);
      const { error: insertError } = await admin.from("checkout_sessions").insert({
        reference, customer_id: user.id, email: profile.email, currency: "ZAR", amount, status: "pending",
        provider: "payfast", environment: config.mode,
        group_id: groupId, share_user_id: user.id,
        groups: [{ storeId: claim.store_id, items: claim.items, subtotal: amount, platformFee, discount: 0, total: amount,
                   subaccountCode: null, shopAmount, platformFeeAmount: platformFee,
                   deliveryLocation: { fulfilment: "collection", group_code: claim.code } }],
      });
      if (insertError) {
        await admin.from("group_order_shares").update({ status: "failed", failure_reason: "session_insert_failed", updated_at: new Date().toISOString() })
          .eq("group_id", groupId).eq("user_id", user.id).eq("reference", reference).eq("status", "processing");
        return json({ error: "Could not start your payment. Please try again." }, 500);
      }
      const out = await checkoutResponse(config, {
        reference, amount, email: profile.email,
        itemName: `ClickFood group order ${claim.code || ""}`, itemDescription: "Your share", returnUrl,
      });
      // marks the share's payment as started (claim_group_share_payment
      // treats a share with no link yet as "still starting")
      await admin.rpc("set_share_auth_url", { p_group: groupId, p_user: user.id, p_reference: reference, p_url: out.url });
      await logEvent(admin, { event_type: "group_pay_started", reference, customer_id: user.id, status: "pending" });
      return json(out);
    }

    // ================= cart =================
    const groups = body.groups;
    const promoCode = body.promoCode || null;
    if (!Array.isArray(groups) || !groups.length) return json({ error: "Your cart is empty." });

    // ---- Re-price every group server-side from live tables ----
    const priced: Array<{ storeId: string; storeName: string; items: any[]; subtotal: number; platformFee: number; deliveryLocation: unknown }> = [];
    let combinedSubtotal = 0;

    for (const group of groups) {
      if (!group.storeId || !Array.isArray(group.items) || !group.items.length) return json({ error: "Invalid cart data." });
      const { data: store } = await admin.from("stores").select("id,name,status").eq("id", group.storeId).single();
      if (!store || store.status !== "approved") return json({ error: "One of the shops in your cart is no longer available." });
      // ordering distance (supabase/order_distance.sql), checked BEFORE taking the money;
      // only the mode and km are kept for the order, never the coordinates
      const loc = (group.deliveryLocation && (group.deliveryLocation as Record<string, unknown>).orderLocation) || { mode: "saved" };
      const { data: dist } = await admin.rpc("order_distance_check", { p_customer: user.id, p_store: group.storeId, p_loc: loc });
      if (dist && dist.ok === false) return json({ error: String(dist.error), distance_blocked: true });
      if (dist && dist.ok) group.deliveryLocation = { ...(group.deliveryLocation || {}), orderLocation: { mode: dist.mode || "saved", km: dist.km ?? null } };

      const menuIds = group.items.filter((i) => !i.isAddon).map((i) => i.menuItemId);
      const addonIds = group.items.filter((i) => i.isAddon).map((i) => i.menuItemId);

      // Opening hours, sold out and time rules: checked BEFORE money is
      // taken, because a paid order is never refused afterwards.
      const { data: blockReason, error: blockError } = await admin.rpc("ordering_block_reason", { p_store_id: group.storeId, p_item_ids: menuIds });
      if (blockError) return json({ error: "We couldn't check this shop's opening hours. Please try again." });
      if (blockReason) return json({ error: blockReason });

      const [{ data: menuItems }, { data: addonItems }, { data: extraLinks }] = await Promise.all([
        menuIds.length ? admin.from("menu_items").select("*").in("id", menuIds).eq("store_id", group.storeId) : Promise.resolve({ data: [] as any[] }),
        addonIds.length ? admin.from("menu_addons").select("*").in("id", addonIds).eq("store_id", group.storeId) : Promise.resolve({ data: [] as any[] }),
        menuIds.length ? admin.from("menu_item_extras_public").select("*").in("menu_item_id", menuIds).eq("store_id", group.storeId) : Promise.resolve({ data: [] as any[] }),
      ]);

      const outItems: any[] = [];
      let groupSubtotal = 0;
      let groupPlatformFee = 0;

      for (const it of group.items) {
        const qty = Math.max(1, Math.round(Number(it.qty) || 1));
        if (it.isAddon) {
          const addon = (addonItems || []).find((a) => a.id === it.menuItemId);
          if (!addon || !addon.is_available) return json({ error: `"${it.menuItemId}" is no longer available.` });
          const price = round2(Number(addon.price));
          outItems.push({ menuItemId: addon.id, name: addon.name, price, qty, image: addon.image_url, addons: [], specialInstructions: "", isAddon: true });
          groupSubtotal += price * qty;
        } else {
          const menuItem = (menuItems || []).find((m) => m.id === it.menuItemId);
          if (!menuItem || !menuItem.available) return json({ error: `"${it.menuItemId}" is no longer available.` });
          if (menuItem.stock < qty) return json({ error: `Only ${menuItem.stock} left of "${menuItem.name}".` });
          let addonsTotal = 0;
          const selections = Array.isArray(it.addons) ? it.addons : [];
          const outAddons: Array<{ id: string; name: string; price: number }> = [];
          for (const sel of selections) {
            // name/price from the browser are never used: re-read from the
            // live view, scoped to this exact product
            const match = (extraLinks || []).find((e) => e.extra_id === sel.id && e.menu_item_id === menuItem.id);
            if (!match) return json({ error: `One or more selected extras are no longer available for "${menuItem.name}".` });
            const extraPrice = round2(Number(match.price));
            addonsTotal += extraPrice;
            outAddons.push({ id: match.extra_id, name: match.name, price: extraPrice });
          }
          // customer price = shop price + ClickFood's per-item fee + extras
          const platformFeeUnit = round2(Number(menuItem.platform_fee_amount || 0));
          const price = round2(Number(menuItem.price) + platformFeeUnit + addonsTotal);
          outItems.push({
            menuItemId: menuItem.id, name: menuItem.name, price, qty,
            image: menuItem.image, addons: outAddons,
            specialInstructions: String(it.specialInstructions || "").slice(0, 200), isAddon: false,
          });
          groupSubtotal += price * qty;
          groupPlatformFee += platformFeeUnit * qty;
        }
      }

      groupSubtotal = round2(groupSubtotal);
      groupPlatformFee = round2(groupPlatformFee);
      combinedSubtotal = round2(combinedSubtotal + groupSubtotal);
      priced.push({ storeId: group.storeId, storeName: store.name, items: outItems, subtotal: groupSubtotal, platformFee: groupPlatformFee, deliveryLocation: group.deliveryLocation || {} });
    }

    // ---- Promo code (server-authoritative, same rules as cash orders) ----
    let combinedDiscount = 0;
    let appliedPromoCode: string | null = null;
    let eligibleByGroup: number[] = priced.map(() => 0);
    if (promoCode) {
      const { data: promo } = await admin.from("promotions").select("*").eq("code", String(promoCode).toUpperCase()).maybeSingle();
      const now = new Date();
      const promoShopSubtotal = priced.filter((g) => !promo || !promo.store_id || g.storeId === promo.store_id).reduce((s, g) => s + Number(g.subtotal), 0);
      const { data: dealBlock } = promo ? await admin.rpc("promo_block_reason", { p_code: promo.code, p_order_subtotal: promoShopSubtotal }) : { data: null };
      // this customer's own rules (verified student, per-customer limit, university/campus):
      // checked BEFORE taking the money, because the paid order is never refused later
      if (promo) {
        const { data: personal } = await admin.rpc("promo_customer_check", { p_code: promo.code, p_customer: user.id });
        if (personal) return json({ error: String(personal), promo_blocked: true });
      }
      if (promo && !dealBlock && promo.active
          && (!promo.expires_at || new Date(promo.expires_at) > now)
          && (!promo.usage_limit || (promo.used_count || 0) < promo.usage_limit)) {
        const productIds: string[] = Array.isArray(promo.menu_item_ids) ? promo.menu_item_ids : [];
        eligibleByGroup = priced.map((g) => round2(g.items.reduce((s, it) =>
          (!productIds.length || (!it.isAddon && productIds.includes(it.menuItemId))) ? s + Number(it.price) * Number(it.qty) : s, 0)));
        const eligible = round2(eligibleByGroup.reduce((a, b) => a + b, 0));
        if (eligible > 0) {
          combinedDiscount = promo.type === "percentage"
            ? round2(eligible * (Number(promo.value) / 100))
            : Math.min(Number(promo.value), eligible);
          appliedPromoCode = promo.code;
        }
      }
    }

    // Split the discount across shops by their share (same as cash orders).
    const eligibleAll = eligibleByGroup.reduce((a, b) => a + b, 0);
    const lastEligible = eligibleByGroup.map((e) => e > 0).lastIndexOf(true);
    let discountLeft = combinedDiscount;
    const finalGroups = priced.map((g, i) => {
      const share = !combinedDiscount || !eligibleByGroup[i] ? 0
        : (i === lastEligible ? discountLeft : round2(combinedDiscount * (eligibleByGroup[i] / eligibleAll)));
      if (i !== lastEligible) discountLeft = round2(discountLeft - share);
      const total = round2(Math.max(0, g.subtotal - share));
      // ClickFood keeps its per-item fee; the rest is what the shop is owed
      // (paid out by ClickFood, see shop_payout_balances). A discount comes
      // off the shop's part first.
      const platformFeeAmount = round2(Math.min(g.platformFee, total));
      return {
        storeId: g.storeId, items: g.items, subtotal: g.subtotal, platformFee: g.platformFee,
        discount: share, total, promoCode: share > 0 ? appliedPromoCode : null,
        deliveryLocation: g.deliveryLocation,
        subaccountCode: null, shopAmount: round2(Math.max(0, total - platformFeeAmount)), platformFeeAmount,
      };
    });

    const combinedTotal = round2(Math.max(0, combinedSubtotal - combinedDiscount));
    if (combinedTotal <= 0) return json({ error: "Unable to start payment for a zero-value order." });

    const itemName = priced.length === 1 ? `ClickFood order, ${priced[0].storeName}` : `ClickFood order, ${priced.length} shops`;
    const itemDescription = priced.flatMap((g) => g.items.filter((it) => !it.isAddon).map((it) => `${it.qty}x ${it.name}`)).join(", ");

    // ---- Same cart again (double tap, back button, "Continue payment"):
    // reuse its open payment instead of starting a second one. ----
    const cartHash = await sha256Hex(JSON.stringify({ mode: config.mode, amount: combinedTotal, groups: finalGroups }));
    const since = new Date(Date.now() - REUSE_MINUTES * 60 * 1000).toISOString();
    const { data: open } = await admin.from("checkout_sessions").select("reference, amount")
      .eq("customer_id", user.id).eq("cart_hash", cartHash).eq("status", "pending").eq("provider", "payfast")
      .eq("environment", config.mode).is("group_id", null).gte("created_at", since)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (open) {
      await logEvent(admin, { event_type: "checkout_reused", reference: open.reference, customer_id: user.id, status: "pending" });
      return json(await checkoutResponse(config, {
        reference: open.reference, amount: Number(open.amount), email: profile.email, itemName, itemDescription, returnUrl, reused: true,
      }));
    }

    const reference = "cf_" + crypto.randomUUID().replace(/-/g, "");
    const { error: insertError } = await admin.from("checkout_sessions").insert({
      reference, customer_id: user.id, email: profile.email, currency: "ZAR",
      amount: combinedTotal, groups: finalGroups, status: "pending",
      provider: "payfast", environment: config.mode, cart_hash: cartHash,
    });
    if (insertError) {
      await logEvent(admin, { event_type: "checkout_failed", customer_id: user.id, status: "failed", failure_reason: insertError.message });
      return json({ error: "Unable to start payment. Please try again." }, 500);
    }

    await logEvent(admin, { event_type: "checkout_started", reference, customer_id: user.id, status: "pending" });
    return json(await checkoutResponse(config, { reference, amount: combinedTotal, email: profile.email, itemName, itemDescription, returnUrl }));
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong starting payment. Please try again." }, 500);
  }
});
