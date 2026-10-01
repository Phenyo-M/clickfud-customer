// ============================================================
// CLICKFUD — send-supplier-email Edge Function
//
// Real backend-sent restock email (never a mailto: link, which would
// open on the MANAGER's own device and send from whatever personal
// account their mail client happens to be signed into). This function:
//   1. Verifies the caller is a real, currently-authenticated, active
//      manager (never trusted from the request body).
//   2. Looks up the supplier server-side and confirms it belongs to
//      that manager's own store — a manager can never email a supplier
//      linked to a different shop, even by guessing/tampering with the
//      supplier_id.
//   3. Refuses if the supplier has no saved email address.
//   4. Sends via Resend (https://resend.com) using RESEND_API_KEY —
//      never exposed to the client, only ever read from the Edge
//      Function's own environment.
//   5. Records the attempt (sent or failed) in supplier_messages via
//      the service-role client — the client can only ever READ that
//      table, never write to it, so a manager can't fabricate a "Sent"
//      record for an email that was never actually delivered.
//
// IMPORTANT — the "from manager's email" requirement in the spec is not
// literally achievable with a normal transactional email API: sending
// AS an arbitrary address you don't control (e.g. a manager's personal
// gmail.com) fails SPF/DKIM/DMARC and gets flagged as spoofing by every
// major mail provider. The realistic equivalent — and what this
// function does — is send FROM a single clickFud-controlled, verified
// address (RESEND_FROM_EMAIL) with reply-to set to the manager's own
// email, and the body signed with the manager's name and shop, so the
// supplier sees exactly who it's from and any reply goes straight to
// the manager, not to clickFud.
//
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (provided
// automatically), plus RESEND_API_KEY and RESEND_FROM_EMAIL (set these
// two yourself via `supabase secrets set` — see project notes).
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const resendApiKey = Deno.env.get("RESEND_API_KEY");
const resendFromEmail = Deno.env.get("RESEND_FROM_EMAIL");

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

    const { supplier_id, subject, body, item_ids } = await req.json() as {
      supplier_id?: string; subject?: string; body?: string; item_ids?: string[];
    };
    // These "business logic" failures are deliberately returned with the
    // default 200 status, not 4xx — the client's convention throughout
    // this app (see App.KitchenStaff.create) is `if (data.error) ...`,
    // which only sees this specific message when the HTTP layer itself
    // reports success. A non-2xx status makes supabase-js's FunctionsHttpError
    // branch fire instead, which this app's client code always collapses
    // to one generic "please try again" message — fine for truly
    // unexpected failures (kept as 401/500 below), but it would hide
    // every one of these deliberate, specific, expected messages.
    if (!supplier_id || !subject || !body) return json({ error: "Missing supplier, subject or message body." });

    const admin = createClient(supabaseUrl, serviceRoleKey);

    const { data: managerProfile } = await admin.from("profiles").select("id, name, email, role, store_id, active")
      .eq("id", userData.user.id).single();
    if (!managerProfile || managerProfile.role !== "manager" || !managerProfile.active) {
      return json({ error: "Only a shop manager can email a supplier." });
    }
    if (!managerProfile.store_id) return json({ error: "You need an approved store first." });

    const { data: store } = await admin.from("stores").select("id, name").eq("id", managerProfile.store_id).single();

    const { data: supplier } = await admin.from("suppliers").select("id, name, email, store_id").eq("id", supplier_id).single();
    if (!supplier || supplier.store_id !== managerProfile.store_id) {
      return json({ error: "Supplier not found." });
    }
    if (!supplier.email) return json({ error: "No email address saved for this supplier." });

    if (!resendApiKey || !resendFromEmail) {
      // Fails loudly rather than silently no-opping or falling back to
      // mailto — the manager needs to know sending isn't configured yet,
      // not see a false "Sent" confirmation.
      return json({ error: "Email sending isn't configured yet. Ask the clickFud team to set up the email service." });
    }

    let sendError: string | null = null;
    try {
      const resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `${managerProfile.name || "clickFud"} (${store?.name || "clickFud"}) <${resendFromEmail}>`,
          to: [supplier.email],
          reply_to: managerProfile.email || undefined,
          subject,
          text: body,
        }),
      });
      if (!resendRes.ok) {
        const errBody = await resendRes.text();
        sendError = `Resend error (${resendRes.status}): ${errBody.slice(0, 300)}`;
      }
    } catch (e) {
      sendError = e instanceof Error ? e.message : "Network error sending the email.";
    }

    await admin.from("supplier_messages").insert({
      store_id: managerProfile.store_id,
      supplier_id: supplier.id,
      sent_by: managerProfile.id,
      sent_by_email: managerProfile.email,
      recipient_email: supplier.email,
      subject,
      body,
      item_ids: item_ids || [],
      status: sendError ? "failed" : "sent",
      error_message: sendError,
    });

    if (sendError) return json({ error: "Could not send the email. Please try again." });
    return json({ data: { sent: true, to: supplier.email } });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong sending this email." }, 500);
  }
});
