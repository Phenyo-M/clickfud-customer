// ============================================================
// CLICKFUD — create-kitchen-staff Edge Function
//
// The ONLY path by which a real role='kitchen' account can ever be
// created. handle_new_user() (migration_governance.sql) deliberately
// still downgrades any self-service signup request for 'kitchen' to
// 'customer' — that stays true here too.
//
// Business rule: every shop's kitchen login is a single SHARED account
// (not one per employee), with a standardized email derived from the
// shop's own name — "<slugified shop name>@kitchen.gmail.com" — never
// a manager-chosen address. The password is the manager's choice. This
// function:
//   1. Verifies the caller is a real, currently-authenticated manager
//      with an approved store (never trusted from the request body).
//   2. Refuses if that store already has a kitchen account — one
//      account per shop; managers reset its password instead of
//      creating a second one (see reset-kitchen-password).
//   3. Derives the email from the store's own name, servers-side —
//      the client may show a preview, but this is the only value ever
//      actually used. Disambiguates with a short store-id suffix only
//      if the plain slug is already taken by a DIFFERENT store.
//   4. Creates the auth user via the Admin API (still lands as
//      'customer' from handle_new_user(), same as any signup).
//   5. Calls provision_kitchen_staff() (security definer, EXECUTE
//      granted only to service_role) to correct the role/store_id past
//      trg_prevent_role_change.
//   6. Best-effort deletes the orphaned auth user if step 5 fails.
//
// Required env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// (all provided automatically by the Supabase Edge Runtime).
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

// Mirrors js/kitchen-staff.js's client-side preview logic exactly — kept
// in sync deliberately so the email the manager sees before submitting
// matches what actually gets created (barring the rare collision case).
function slugifyShopName(name: string) {
  return (name || "")
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 40) || "shop";
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

    // The caller's own role/store — never trusted from the request body.
    const { data: managerProfile } = await admin.from("profiles").select("role, store_id, active")
      .eq("id", userData.user.id).single();
    if (!managerProfile || managerProfile.role !== "manager" || !managerProfile.active) {
      return json({ error: "Only a shop manager can set up a kitchen account." }, 403);
    }
    if (!managerProfile.store_id) {
      return json({ error: "You need an approved store before you can set up a kitchen account." }, 403);
    }
    const { data: store } = await admin.from("stores").select("id, name, status").eq("id", managerProfile.store_id).single();
    if (!store || store.status !== "approved") {
      return json({ error: "Your store must be approved before you can set up a kitchen account." }, 403);
    }

    const { data: existing } = await admin.from("profiles").select("id").eq("store_id", store.id).eq("role", "kitchen").limit(1);
    if (existing && existing.length) {
      return json({ error: "This shop already has a kitchen account. Reset its password instead of creating a new one." });
    }

    const baseSlug = slugifyShopName(store.name);
    let email = `${baseSlug}@kitchen.gmail.com`;

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { name: `${store.name} Kitchen` },
    });
    let finalUser = created?.user;
    if (createErr) {
      // Supabase's actual wording is "A user with this email address has
      // already been registered" — matched loosely (not an exact phrase)
      // so this doesn't silently stop catching the collision case if the
      // wording changes slightly in a future GoTrue version.
      if (!/already.*(registered|exists)|duplicate/i.test(createErr.message || "")) {
        return json({ error: createErr.message || "Could not create the account." });
      }
      // The plain slug belongs to a different shop with a similar/identical
      // name — disambiguate with a short suffix from this store's own id
      // rather than fail outright.
      email = `${baseSlug}-${store.id.slice(0, 4)}@kitchen.gmail.com`;
      const retry = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { name: `${store.name} Kitchen` },
      });
      if (retry.error || !retry.data.user) {
        return json({ error: retry.error?.message || "Could not create the account." });
      }
      finalUser = retry.data.user;
    }
    if (!finalUser) return json({ error: "Could not create the account." });

    const { error: provisionErr } = await admin.rpc("provision_kitchen_staff", {
      p_user_id: finalUser.id,
      p_store_id: store.id,
      p_name: `${store.name} Kitchen`,
    });
    if (provisionErr) {
      await admin.auth.admin.deleteUser(finalUser.id);
      return json({ error: "Could not set up the kitchen account. Please try again." }, 500);
    }

    return json({ data: { id: finalUser.id, name: `${store.name} Kitchen`, email } });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong creating this account." }, 500);
  }
});
