// ============================================================
// CLICKFUD — paystack-initialize Edge Function
//
// Starts a real Paystack TEST-mode transaction for the customer's
// current cart. The browser only ever sends WHICH items/quantities were
// selected — never a price. Every price used here is re-derived from the
// live menu_items/menu_addons rows (mirroring the same fixed logic as
// the validate_order_pricing DB trigger, which independently re-checks
// everything again the moment the real order rows are eventually
// created in finalize_paystack_checkout()). No order row exists yet at
// this point — see supabase/migration_governance.sql section 15 for the
// full flow.
//
// Required secret (set via `supabase secrets set` or the Dashboard):
//   PAYSTACK_SECRET_KEY  — a TEST secret key (starts with sk_test_)
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are
// provided automatically by the Supabase Edge Runtime.
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
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function round2(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Best-effort audit trail (payment_events) — never blocks or fails the
// actual payment flow if logging itself has a problem, and never logs
// anything beyond safe metadata (reference/status/reason), never card data.
async function logEvent(admin: SupabaseClient, row: {
  event_type: string; reference?: string | null; customer_id?: string | null; status?: string | null; failure_reason?: string | null;
}) {
  try { await admin.from("payment_events").insert({ source: "paystack-initialize", ...row }); } catch (_e) { /* never fail the payment over a logging error */ }
}

interface ExtraSelectionInput {
  id: string;
  // name/price may be present from the client but are never trusted —
  // see the live item_extras/item_extra_links lookup below, which
  // mirrors validate_order_pricing() in migration_governance.sql
  // section 29 so both authoritative paths agree.
  name?: string;
  price?: number;
}
interface CartItemInput {
  menuItemId: string;
  qty: number;
  isAddon?: boolean;
  addons?: ExtraSelectionInput[];
  specialInstructions?: string;
}
interface GroupInput {
  storeId: string;
  items: CartItemInput[];
  deliveryLocation: Record<string, unknown>;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return json({ error: "Please sign in to pay online." }, 401);
    const user = userData.user;

    const { groups, promoCode, callbackUrl } = await req.json() as {
      groups: GroupInput[]; promoCode?: string | null; callbackUrl?: string;
    };
    if (!Array.isArray(groups) || !groups.length) return json({ error: "Your cart is empty." });
    if (!callbackUrl) return json({ error: "Missing callback URL." });

    const admin = createClient(supabaseUrl, serviceRoleKey);

    const { data: profile } = await admin.from("profiles").select("id,email,name").eq("id", user.id).single();
    if (!profile) return json({ error: "Profile not found." }, 404);

    // ---- Re-price every group server-side from live tables ----
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
        // Per-product extras (item_extras/item_extra_links, migration_governance.sql
        // section 29) — the view already filters to available=true and joins the
        // extra's own name/price in, scoped to this store and these exact menu items.
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
            // Never trust sel.name/sel.price — re-derive both from the live,
            // product-scoped view. A tampered id that resolves to an extra
            // belonging to a DIFFERENT menu item won't be in this filtered
            // list at all, since it's already scoped to menuItem.id above.
            const match = (extraLinks || []).find((e) => e.extra_id === sel.id && e.menu_item_id === menuItem.id);
            if (!match) return json({ error: `One or more selected extras are no longer available for "${menuItem.name}".` });
            const extraPrice = round2(Number(match.price));
            addonsTotal += extraPrice;
            outAddons.push({ id: match.extra_id, name: match.name, price: extraPrice });
          }
          // Customer-facing price includes the developer's own per-item
          // platform fee (set at menu approval — see enforce_menu_item_status
          // / menu-review.js) — one combined price, same as the shop's own
          // price plus extras. The fee itself is tracked separately below so
          // the split (platform vs. shop subaccount) can be computed from it
          // directly, replacing the old percentage-of-total commission.
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

    // ---- Promo code (server-authoritative, against the real table) ----
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

    // Allocate the combined discount proportionally by each store's share
    // of the combined subtotal — same algorithm the client uses when
    // splitting a COD multi-shop checkout, kept consistent here.
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

    // ---- Payout readiness: every shop in this cart must already have an
    // active Paystack subaccount, or the money for its share has nowhere
    // legitimate to go — checkout is refused outright rather than ever
    // silently reassigning one shop's money to another or to the platform. ----
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

    // ---- Split each group's total between the shop's subaccount and the
    // platform. The platform's share is the sum of the developer's own
    // per-item fees (set at menu approval), NOT a percentage of the total —
    // replaces the old commission_percent-based split. Capped at the
    // group's actual (post-discount) total so a promo discount is always
    // absorbed by the shop's own share first, never pushed into a negative
    // shop payout; the platform's fee only shrinks if a discount is large
    // enough to eat into it. ----
    const finalGroups = preSplitGroups.map((g) => {
      const account = (payoutAccounts || []).find((a) => a.store_id === g.storeId)!;
      const platformFeeAmount = round2(Math.min(g.platformFee, g.total));
      const shopAmount = round2(Math.max(0, g.total - platformFeeAmount));
      return { ...g, subaccountCode: account.paystack_subaccount_code, shopAmount, platformFeeAmount };
    });

    const reference = "cf_" + crypto.randomUUID().replace(/-/g, "");
    const currency = "ZAR";

    const { error: insertError } = await admin.from("checkout_sessions").insert({
      reference,
      customer_id: user.id,
      email: profile.email,
      currency,
      amount: combinedTotal,
      groups: finalGroups,
      status: "pending",
    });
    if (insertError) return json({ error: "Unable to start payment. Please try again." }, 500);

    // ---- Paystack Transaction Split: one dynamic split per checkout,
    // since the shares differ every time. Whatever isn't allocated to a
    // subaccount here is what the platform's own main account receives.
    //
    // bearer_type is "all-proportional" (fee spread across the shop
    // subaccounts, proportional to their share) rather than "account" —
    // with the platform commission defaulting to 0%, the main account's
    // computed share is exactly zero, and Paystack's Split API rejects
    // that when the main account is also expected to absorb its own
    // transaction fee ("Merchant share cannot be lower than zero"). This
    // is the correct behaviour for a 0%-commission platform: there is no
    // platform-retained cut to draw a fee from, so the fee is honestly
    // borne by the shops themselves. If a non-zero commission is
    // configured later, this still works unchanged.
    const splitSubaccounts = finalGroups
      .filter((g) => g.shopAmount > 0)
      .map((g) => ({ subaccount: g.subaccountCode, share: Math.round(g.shopAmount * 100) }));

    let splitCode: string | null = null;
    if (splitSubaccounts.length) {
      const splitRes = await fetch("https://api.paystack.co/split", {
        method: "POST",
        headers: { Authorization: `Bearer ${paystackSecretKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `clickfud-${reference}`,
          type: "flat",
          currency,
          subaccounts: splitSubaccounts,
          bearer_type: "all-proportional",
        }),
      });
      const splitData = await splitRes.json();
      if (!splitRes.ok || !splitData.status) {
        const reason = splitData?.message || "split_setup_failed";
        await admin.from("checkout_sessions").update({ status: "failed", failure_reason: reason }).eq("reference", reference);
        await logEvent(admin, { event_type: "initialize_failed", reference, customer_id: user.id, status: "failed", failure_reason: reason });
        return json({ error: splitData?.message || "Unable to set up payment split for this order." }, 502);
      }
      splitCode = splitData.data.split_code;
    }

    const paystackRes = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { Authorization: `Bearer ${paystackSecretKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: profile.email,
        amount: Math.round(combinedTotal * 100),
        currency,
        reference,
        callback_url: callbackUrl,
        split_code: splitCode || undefined,
        metadata: { customer_id: user.id },
      }),
    });
    const paystackData = await paystackRes.json();
    if (!paystackRes.ok || !paystackData.status) {
      const reason = paystackData?.message || "initialize_api_failed";
      await admin.from("checkout_sessions").update({ status: "failed", failure_reason: reason }).eq("reference", reference);
      await logEvent(admin, { event_type: "initialize_failed", reference, customer_id: user.id, status: "failed", failure_reason: reason });
      return json({ error: paystackData?.message || "Unable to start payment with Paystack." }, 502);
    }

    await logEvent(admin, { event_type: "initialize_success", reference, customer_id: user.id, status: "pending" });
    return json({ authorization_url: paystackData.data.authorization_url, reference });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong starting payment. Please try again." }, 500);
  }
});
