// ============================================================
// CLICKFUD — paystack-charge-saved Edge Function
//
// The "one-tap wallet" checkout path — charges a customer's own
// previously-saved card (public.payment_methods, written only after a
// real verified transaction — see paystack-verify) directly via
// Paystack's /transaction/charge_authorization, with no redirect to
// Paystack's hosted checkout page at all.
//
// Re-uses paystack-initialize's exact pricing/payout-split logic (never
// trusts a client-sent price) and, on a genuinely successful charge,
// finalizes through the SAME finalize_paystack_checkout() RPC that both
// the redirect flow and the webhook use — one single source of truth for
// "an order becomes real", regardless of which path paid for it.
//
// Paystack's charge_authorization can come back non-'success' (declined,
// or a card that now needs interactive re-authentication it can't do
// without a browser present) — that is reported back as a normal,
// non-fatal failure so the frontend can fall back to a full Paystack
// Checkout redirect, never silently treated as paid.
//
// Required secret: PAYSTACK_SECRET_KEY (same TEST key as the other
// paystack-* functions).
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

function round2(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function logEvent(admin: SupabaseClient, row: {
  event_type: string; reference?: string | null; customer_id?: string | null; status?: string | null; failure_reason?: string | null;
}) {
  try { await admin.from("payment_events").insert({ source: "paystack-charge-saved", ...row }); } catch (_e) { /* never fail the charge over a logging error */ }
}

interface ExtraSelectionInput { id: string; name?: string; price?: number; }
interface CartItemInput {
  menuItemId: string; qty: number; isAddon?: boolean;
  addons?: ExtraSelectionInput[]; specialInstructions?: string;
}
interface GroupInput { storeId: string; items: CartItemInput[]; deliveryLocation: Record<string, unknown>; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return json({ error: "Please sign in to pay." }, 401);
    const user = userData.user;

    const { groups, promoCode, paymentMethodId, idempotencyKey } = await req.json() as {
      groups: GroupInput[]; promoCode?: string | null; paymentMethodId?: string; idempotencyKey?: string | null;
    };
    if (!Array.isArray(groups) || !groups.length) return json({ error: "Your cart is empty." });
    if (!paymentMethodId) return json({ error: "Missing payment method." });

    const admin = createClient(supabaseUrl, serviceRoleKey);

    const { data: profile } = await admin.from("profiles").select("id,email,name").eq("id", user.id).single();
    if (!profile) return json({ error: "Profile not found." }, 404);

    // Owned-by-this-customer check happens here (service role bypasses
    // RLS) rather than relying on the "select own" policy alone — this is
    // the one place a stolen/guessed id could otherwise charge someone
    // else's saved card.
    const { data: method } = await admin.from("payment_methods").select("*")
      .eq("id", paymentMethodId).eq("customer_id", user.id).maybeSingle();
    if (!method) return json({ error: "That payment method was not found on your account." }, 404);

    // ---- Duplicate-charge protection ----
    // The app sends the same idempotencyKey for every retry of one
    // checkout (e.g. the phone lost signal before our response arrived,
    // so it can't know whether the card was charged). The key becomes
    // the Paystack reference, so a retry finds the ORIGINAL attempt here
    // instead of charging the card a second time — and Paystack itself
    // also rejects a reused reference as a last line of defence.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const idemKey = typeof idempotencyKey === "string" && UUID_RE.test(idempotencyKey) ? idempotencyKey.toLowerCase() : null;
    const idemReference = idemKey ? "cf_" + idemKey.replace(/-/g, "") : null;
    if (idemReference) {
      const { data: existing } = await admin.from("checkout_sessions")
        .select("reference,status,customer_id").eq("reference", idemReference).maybeSingle();
      if (existing) {
        if (existing.customer_id !== user.id) return json({ ok: false, error: "Invalid payment request." }, 403);
        if (existing.status === "paid") {
          // Already charged and (finalize is idempotent) already turned
          // into orders — just hand back the same orders.
          const { data: finalized, error: finalizeError } = await admin.rpc("finalize_paystack_checkout", { p_reference: idemReference });
          if (finalizeError) return json({ ok: false, error: "Your payment went through but we couldn't load your order. Please check My Orders or contact support with reference " + idemReference + "." }, 500);
          await logEvent(admin, { event_type: "charge_saved_replayed", reference: idemReference, customer_id: user.id, status: "paid" });
          return json({ ok: true, orderIds: finalized.order_ids, replayed: true });
        }
        if (existing.status === "pending") {
          // The earlier attempt hasn't reached a final state (or its result
          // was lost). Never charge again — paystack-webhook finalizes it
          // if Paystack did take the money, and the next retry then lands
          // in the "paid" branch above.
          return json({ ok: false, transient: true, error: "Your previous payment attempt is still being confirmed. Please check My Orders in a minute before trying again." });
        }
        return json({ ok: false, error: "That payment didn't go through. Please try again." });
      }
    }

    // ---- Re-price every group server-side from live tables (identical to paystack-initialize) ----
    const priced: Array<{ storeId: string; items: unknown[]; subtotal: number; platformFee: number; deliveryLocation: unknown }> = [];
    let combinedSubtotal = 0;

    for (const group of groups) {
      if (!group.storeId || !Array.isArray(group.items) || !group.items.length) {
        return json({ error: "Invalid cart data." });
      }
      const { data: store } = await admin.from("stores").select("*").eq("id", group.storeId).single();
      if (!store || store.status !== "approved") return json({ error: "One of the shops in your cart is no longer available." });

      const menuIds = group.items.filter((i) => !i.isAddon).map((i) => i.menuItemId);
      const addonIds = group.items.filter((i) => i.isAddon).map((i) => i.menuItemId);

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
            const match = (extraLinks || []).find((e) => e.extra_id === sel.id && e.menu_item_id === menuItem.id);
            if (!match) return json({ error: `One or more selected extras are no longer available for "${menuItem.name}".` });
            const extraPrice = round2(Number(match.price));
            addonsTotal += extraPrice;
            outAddons.push({ id: match.extra_id, name: match.name, price: extraPrice });
          }
          // Customer-facing price includes the developer's own per-item
          // platform fee (set at menu approval) — same combined-price model
          // as paystack-initialize; kept identical between the two so a
          // saved-card charge never prices an item differently than the
          // redirect-checkout path would have.
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
      priced.push({ storeId: group.storeId, items: outItems, subtotal: groupSubtotal, platformFee: groupPlatformFee, deliveryLocation: group.deliveryLocation || {} });
    }

    let combinedDiscount = 0;
    let appliedPromoCode: string | null = null;
    // What the discount is worked out on, per shop: a product code only
    // counts its chosen products' lines (price incl. extras + platform fee, x qty);
    // a legacy code with no product counts the whole order. Same rule as
    // validate_order_pricing (SQL) and js/promotions.js.
    let eligibleByGroup: number[] = priced.map(() => 0);
    if (promoCode) {
      const { data: promo } = await admin.from("promotions").select("*").eq("code", String(promoCode).toUpperCase()).maybeSingle();
      const now = new Date();
      if (promo && promo.active
          && (!promo.expires_at || new Date(promo.expires_at) > now)
          && (!promo.usage_limit || (promo.used_count || 0) < promo.usage_limit)) {
        const productIds: string[] = Array.isArray(promo.menu_item_ids) ? promo.menu_item_ids : [];
        eligibleByGroup = priced.map((g) => round2((g.items as any[]).reduce((s, it) =>
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

    const eligibleAll = eligibleByGroup.reduce((a, b) => a + b, 0);
    const lastEligible = eligibleByGroup.map((e) => e > 0).lastIndexOf(true);
    let discountLeft = combinedDiscount;
    const preSplitGroups = priced.map((g, i) => {
      const share = !combinedDiscount || !eligibleByGroup[i] ? 0
        : (i === lastEligible ? discountLeft : round2(combinedDiscount * (eligibleByGroup[i] / eligibleAll)));
      if (i !== lastEligible) discountLeft = round2(discountLeft - share);
      return {
        storeId: g.storeId, items: g.items, subtotal: g.subtotal, platformFee: g.platformFee,
        discount: share, total: round2(Math.max(0, g.subtotal - share)),
        promoCode: share > 0 ? appliedPromoCode : null,
        deliveryLocation: g.deliveryLocation,
      };
    });

    const combinedTotal = round2(Math.max(0, combinedSubtotal - combinedDiscount));
    if (combinedTotal <= 0) return json({ error: "Unable to start payment for a zero-value order." });

    const storeIds = preSplitGroups.map((g) => g.storeId);
    const [{ data: payoutAccounts }, { data: storeRows }] = await Promise.all([
      admin.from("store_payout_accounts").select("store_id,status,paystack_subaccount_code").in("store_id", storeIds),
      admin.from("stores").select("id,name").in("id", storeIds),
    ]);

    for (const storeId of storeIds) {
      const account = (payoutAccounts || []).find((a) => a.store_id === storeId);
      if (!account || account.status !== "active") {
        const storeRow = (storeRows || []).find((s) => s.id === storeId);
        return json({ error: `${storeRow ? storeRow.name : "One of the shops in your cart"} hasn't set up online payouts yet. Please pay with cash for now, or try again once the shop has completed payout setup.` });
      }
    }

    // Same replacement as paystack-initialize: the platform's share is the
    // sum of the developer's own per-item fees, capped at the group's
    // actual (post-discount) total so a discount is absorbed by the shop's
    // share first.
    const finalGroups = preSplitGroups.map((g) => {
      const account = (payoutAccounts || []).find((a) => a.store_id === g.storeId)!;
      const platformFeeAmount = round2(Math.min(g.platformFee, g.total));
      const shopAmount = round2(Math.max(0, g.total - platformFeeAmount));
      return { ...g, subaccountCode: account.paystack_subaccount_code, shopAmount, platformFeeAmount };
    });

    const reference = idemReference || "cf_" + crypto.randomUUID().replace(/-/g, "");
    const currency = "ZAR";

    const { error: insertError } = await admin.from("checkout_sessions").insert({
      reference, customer_id: user.id, email: profile.email, currency,
      amount: combinedTotal, groups: finalGroups, status: "pending",
    });
    if (insertError) {
      // Primary-key clash: a concurrent request with the same key got here
      // first — that one owns the charge; this one must not make another.
      if (insertError.code === "23505") {
        return json({ ok: false, transient: true, error: "Your payment is already being processed. Please check My Orders in a minute." });
      }
      return json({ error: "Unable to start payment. Please try again." }, 500);
    }

    const splitSubaccounts = finalGroups
      .filter((g) => g.shopAmount > 0)
      .map((g) => ({ subaccount: g.subaccountCode, share: Math.round(g.shopAmount * 100) }));

    let splitCode: string | null = null;
    if (splitSubaccounts.length) {
      const splitRes = await fetch("https://api.paystack.co/split", {
        method: "POST",
        headers: { Authorization: `Bearer ${paystackSecretKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `clickfud-${reference}`, type: "flat", currency,
          subaccounts: splitSubaccounts, bearer_type: "all-proportional",
        }),
      });
      const splitData = await splitRes.json();
      if (!splitRes.ok || !splitData.status) {
        await admin.from("checkout_sessions").update({ status: "failed" }).eq("reference", reference);
        return json({ error: splitData?.message || "Unable to set up payment split for this order." }, 502);
      }
      splitCode = splitData.data.split_code;
    }

    // ---- The actual "one-tap" charge — no redirect, no hosted checkout page ----
    const chargeRes = await fetch("https://api.paystack.co/transaction/charge_authorization", {
      method: "POST",
      headers: { Authorization: `Bearer ${paystackSecretKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        authorization_code: method.paystack_authorization_code,
        email: profile.email,
        amount: Math.round(combinedTotal * 100),
        currency,
        reference,
        split_code: splitCode || undefined,
        metadata: { customer_id: user.id },
      }),
    });
    const chargeData = await chargeRes.json();

    const paidOk = chargeRes.ok && chargeData.status && chargeData.data?.status === "success";
    const amountOk = paidOk && chargeData.data?.amount === Math.round(combinedTotal * 100) && chargeData.data?.currency === currency;

    if (!paidOk || !amountOk) {
      const reason = chargeData.data?.gateway_response || chargeData.message || "charge_authorization_failed";
      await admin.rpc("mark_paystack_checkout_failed", { p_reference: reference, p_reason: reason });
      await logEvent(admin, { event_type: "charge_saved_failed", reference, customer_id: user.id, status: "failed", failure_reason: reason });
      // Not a hard error state — this saved card just couldn't complete a
      // charge without a browser present (e.g. it now needs interactive
      // re-authentication). The frontend can fall back to a normal
      // Paystack Checkout redirect using this same reference/session.
      return json({
        ok: false,
        fallbackToCheckout: true,
        error: chargeData.data?.gateway_response || chargeData.message || "This saved card couldn't be charged. Please try again or use a different payment method.",
      });
    }

    const { data: finalized, error: finalizeError } = await admin.rpc("finalize_paystack_checkout", { p_reference: reference });
    if (finalizeError) {
      await logEvent(admin, { event_type: "finalize_failed", reference, customer_id: user.id, status: "error", failure_reason: String(finalizeError.message || finalizeError) });
      return json({ ok: false, error: "Payment succeeded but we couldn't create your order. Please contact support with reference " + reference + "." }, 500);
    }
    await logEvent(admin, { event_type: "charge_saved_success", reference, customer_id: user.id, status: "paid" });

    return json({ ok: true, orderIds: finalized.order_ids });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: "Something went wrong processing your payment." }, 500);
  }
});
