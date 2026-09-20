// ============================================================
// CLICKFUD — paystack-manage-subaccount Edge Function
//
// The only path that ever creates/updates a shop's Paystack subaccount
// (its payout destination for the multi-shop transaction split) and the
// only path that ever writes public.store_payout_accounts — a manager
// can SELECT their own row via RLS, but INSERT/UPDATE on that table has
// no policy at all, so this Edge Function (service role) is the sole
// writer. The full bank account number passes through this function
// once, straight to Paystack over HTTPS, and is never written to our
// own database — only Paystack's returned subaccount identifiers and
// the last 4 digits (for the masked "****1234" display) are stored.
//
// Steps: 1) verify caller is the manager who owns this exact store,
// 2) create a new subaccount or update the existing one, 3) upsert
// store_payout_accounts with the result.
//
// There is deliberately NO account-name "resolve" step before this —
// Paystack's /bank/resolve (verify-account-name) endpoint is a
// Nigeria/Ghana-only feature (confirmed against Paystack's own
// documentation) and always fails with a currency-list error for a
// South African account, regardless of how it's called. The manager
// types their own account holder name instead (accountName below),
// and Paystack's subaccount creation call itself is the real
// validation of the account number/bank combination for ZAR.
//
// Required secret: PAYSTACK_SECRET_KEY (TEST key).
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

    const { businessName, bankCode, bankName, accountNumber, accountName, contactEmail, contactPhone } = await req.json() as {
      businessName?: string; bankCode?: string; bankName?: string; accountNumber?: string; accountName?: string; contactEmail?: string; contactPhone?: string;
    };
    if (!businessName?.trim() || !bankCode || !bankName || !accountNumber?.trim() || !accountName?.trim()) {
      return json({ error: "Please fill in your business name, bank, account number and account holder name." });
    }
    const cleanAccountNumber = accountNumber.replace(/\s+/g, "");
    if (!/^\d{6,17}$/.test(cleanAccountNumber)) return json({ error: "Please enter a valid account number." });

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data: profile } = await admin.from("profiles").select("id,role,store_id,email").eq("id", userData.user.id).single();
    if (!profile || profile.role !== "manager" || !profile.store_id) {
      return json({ error: "Only a shop's own manager can set up its payout account." }, 403);
    }
    const { data: store } = await admin.from("stores").select("id,name,commission_percent").eq("id", profile.store_id).single();
    if (!store) return json({ error: "Shop not found." }, 404);

    // ---- Create or update the subaccount ----
    const { data: existing } = await admin.from("store_payout_accounts").select("*").eq("store_id", store.id).maybeSingle();

    const subaccountBody = {
      business_name: businessName.trim().slice(0, 100),
      settlement_bank: bankCode,
      account_number: cleanAccountNumber,
      percentage_charge: 0, // Paystack requires a value here; the real per-order split is computed per-transaction in paystack-initialize, not via this field.
      primary_contact_email: contactEmail || profile.email,
      primary_contact_phone: contactPhone || undefined,
    };

    const isUpdate = existing?.paystack_subaccount_code;
    const psRes = await fetch(
      isUpdate ? `https://api.paystack.co/subaccount/${existing.paystack_subaccount_code}` : "https://api.paystack.co/subaccount",
      {
        method: isUpdate ? "PUT" : "POST",
        headers: { Authorization: `Bearer ${paystackSecretKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(subaccountBody),
      },
    );
    const psData = await psRes.json();
    console.log("PAYSTACK subaccount request body:", JSON.stringify(subaccountBody));
    console.log("PAYSTACK subaccount response:", psRes.status, JSON.stringify(psData));
    if (!psRes.ok || !psData.status) {
      await admin.from("store_payout_accounts").upsert({
        store_id: store.id, status: "failed", last_error: psData?.message || "Paystack rejected this payout setup.", last_synced_at: new Date().toISOString(),
      });
      return json({ error: psData?.message || "Paystack couldn't set up this payout account. Please check your details and try again.", step: "create_subaccount", paystackStatus: psRes.status, sentBody: subaccountBody });
    }

    const last4 = cleanAccountNumber.slice(-4);
    const { error: upsertError } = await admin.from("store_payout_accounts").upsert({
      store_id: store.id,
      paystack_subaccount_code: psData.data.subaccount_code,
      paystack_subaccount_id: psData.data.id,
      business_name: businessName.trim(),
      bank_code: bankCode,
      bank_name: bankName,
      account_number_last4: last4,
      account_name: accountName.trim(),
      currency: "ZAR",
      country: "South Africa",
      status: "active",
      last_error: null,
      last_synced_at: new Date().toISOString(),
    });
    if (upsertError) return json({ error: "Payout account created with Paystack, but we couldn't save it. Please try again." }, 500);

    return json({
      ok: true,
      status: "active",
      accountName: accountName.trim(),
      bankName,
      accountNumberLast4: last4,
    });
  } catch (e) {
    return json({ error: "Something went wrong setting up your payout account." }, 500);
  }
});
