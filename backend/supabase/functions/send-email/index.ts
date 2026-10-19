// send-email: sends one row of public.email_outbox through Resend.
//
// Called only by the database (public.dispatch_email via pg_net) with the
// shared secret in x-email-secret, never from a browser. Deploy with
// --no-verify-jwt (there is no user JWT on these calls).
//
// 1. Claims the row atomically (queued/failed -> sending, attempts + 1), so
//    two calls for the same row can't both send.
// 2. Renders the template for its kind (templates.ts).
// 3. Sends via Resend with an Idempotency-Key of "<id>-<attempt>", so a
//    retried HTTP call for the same attempt can't send twice.
// 4. Records sent (accepted by Resend, with its message id) or failed.
//
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (automatic),
// RESEND_API_KEY, RESEND_FROM_EMAIL, EMAIL_DISPATCH_SECRET.
// Optional: RESEND_API_URL (tests point this at a local stand-in).
import { createClient } from "npm:@supabase/supabase-js@2";
import { render, hasTemplate } from "./templates.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const resendApiKey = Deno.env.get("RESEND_API_KEY");
const resendFrom = Deno.env.get("RESEND_FROM_EMAIL");
const dispatchSecret = Deno.env.get("EMAIL_DISPATCH_SECRET");
const resendUrl = Deno.env.get("RESEND_API_URL") || "https://api.resend.com/emails";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!dispatchSecret || !safeEqual(req.headers.get("x-email-secret") || "", dispatchSecret)) {
    return json({ error: "Not allowed" }, 401);
  }
  let id = "";
  try { id = String((await req.json()).id || ""); } catch { /* bad body */ }
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Bad id" }, 400);

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const { data: rows, error: claimErr } = await admin.from("email_outbox")
    .update({ status: "sending", last_attempt_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id).in("status", ["queued", "failed"])
    .select("*");
  if (claimErr) return json({ error: "Could not claim email" }, 500);
  const row = rows && rows[0];
  if (!row) return json({ skipped: true });

  const attempt = (row.attempts || 0) + 1;
  const finish = async (patch: Record<string, unknown>) => {
    await admin.from("email_outbox").update({ ...patch, attempts: attempt, updated_at: new Date().toISOString() }).eq("id", id);
  };

  if (!resendApiKey || !resendFrom) {
    await finish({ status: "failed", error: "Email sending is not configured (Resend key or sender missing)." });
    return json({ error: "not configured" });
  }
  if (!hasTemplate(row.kind)) {
    await finish({ status: "failed", error: `No template for ${row.kind}.` });
    return json({ error: "no template" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.recipient_email || "")) {
    await finish({ status: "failed", error: "Recipient email address is not valid." });
    return json({ error: "bad recipient" });
  }

  const mail = render(row);
  try {
    const res = await fetch(resendUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `${id}-${attempt}`,
      },
      body: JSON.stringify({
        from: `ClickFood <${resendFrom}>`,
        to: [row.recipient_email],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        tags: [{ name: "kind", value: row.kind }],
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = String((body && (body.message || body.error)) || `HTTP ${res.status}`).slice(0, 300);
      await finish({ status: "failed", error: `Resend: ${msg}` });
      return json({ error: msg });
    }
    await finish({ status: "sent", sent_at: new Date().toISOString(), provider_id: body.id || null, error: null });
    return json({ sent: true, id: body.id || null });
  } catch (e) {
    await finish({ status: "failed", error: `Could not reach Resend: ${String(e).slice(0, 200)}` });
    return json({ error: "network" }, 502);
  }
});
