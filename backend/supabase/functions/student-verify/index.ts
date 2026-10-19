// ============================================================
// CLICKFOOD — student-verify Edge Function
//
// Proves a customer can open a university email, for student-only deals.
// The student's login email never changes.
//
//   POST { action: "start", email, university_id?, campus_id? }
//        makes a one-time token, stores only its SHA-256 hash (via
//        student_verify_start, which also applies the institution rules and
//        the rate limits), and emails a link to the university address.
//   POST { action: "confirm", token }
//        the signed-in student opened the link: the hash must match THEIR
//        pending request (student_verify_confirm).
//
// Caller identity comes from the Supabase JWT (checked here), never from
// the body. Needs RESEND_API_KEY + RESEND_FROM_EMAIL (already set for the
// other emails). Optional: RESEND_API_URL, APP_URL (tests).
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import { clientKey, limited } from "../_shared/limit.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const resendApiKey = Deno.env.get("RESEND_API_KEY");
const resendFrom = Deno.env.get("RESEND_FROM_EMAIL");
const resendUrl = Deno.env.get("RESEND_API_URL") || "https://api.resend.com/emails";
const appUrl = Deno.env.get("APP_URL") || "https://clickfood.co.za";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", ...extra } });
}
async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function newToken(): string {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function emailBody(name: string, link: string) {
  const first = (name || "").trim().split(/\s+/)[0] || "there";
  const subject = "Confirm your student email for ClickFood";
  const text = [`Hi ${first},`, "", "Tap the link below to confirm this is your university email. It works for 24 hours.", "", link, "",
    "If you didn't ask for this, you can ignore this email. Your ClickFood login is not changed.", "", "The ClickFood Team"].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#F8F3EA;font-family:Arial,Helvetica,sans-serif;color:#2A1A14;">
<div style="max-width:520px;margin:0 auto;padding:28px 20px;">
<p style="font-size:20px;font-weight:800;color:#E04A1F;margin:0 0 18px;">ClickFood</p>
<p style="margin:0 0 12px;">Hi ${esc(first)},</p>
<p style="margin:0 0 20px;">Tap the button to confirm this is your university email. It works for 24 hours.</p>
<p style="margin:0 0 24px;"><a href="${esc(link)}" style="display:inline-block;background:#E04A1F;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:999px;">Confirm student email</a></p>
<p style="margin:0;font-size:12px;color:#6E6058;">If you didn't ask for this, you can ignore this email. Your ClickFood login is not changed.</p>
</div></body></html>`;
  return { subject, text, html };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who } = token ? await admin.auth.getUser(token) : { data: null };
  const uid = who && who.user ? who.user.id : null;
  if (!uid) return json({ error: "Please sign in." }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400); }

  // a general limit per account and per network, on top of the database's own email limits
  const tooMany = (await limited(admin, "acct:" + uid, "student_verify", 20, 3600, corsHeaders, "Too many tries. Please wait a while."))
    || (await limited(admin, await clientKey(req), "student_verify_ip", 60, 3600, corsHeaders, "Too many tries. Please wait a while."));
  if (tooMany) return tooMany;

  if (body.action === "start") {
    if (!resendApiKey || !resendFrom) return json({ error: "Student verification isn't available right now." }, 503);
    const email = String(body.email || "").trim().toLowerCase().slice(0, 254);
    const uni = typeof body.university_id === "string" && body.university_id ? body.university_id : null;
    const campus = typeof body.campus_id === "string" && body.campus_id ? body.campus_id : null;
    const t = newToken();
    const { data: r, error } = await admin.rpc("student_verify_start", { p_user: uid, p_email: email, p_university: uni, p_campus: campus, p_token_hash: await sha256Hex(t) });
    if (error) { console.error("student_verify_start", error.message); return json({ error: "We couldn't start the verification. Please try again." }, 500); }
    if (!r || !r.ok) return json(r || { ok: false, error: "We couldn't start the verification." }, r && r.retry_after ? 429 : 200, r && r.retry_after ? { "Retry-After": String(r.retry_after) } : {});
    const link = `${appUrl}/?student_verify=${encodeURIComponent(t)}`;
    const m = emailBody(String(r.name || ""), link);
    try {
      const res = await fetch(resendUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: `ClickFood <${resendFrom}>`, to: [email], subject: m.subject, text: m.text, html: m.html, tags: [{ name: "kind", value: "student_verify" }] }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) { console.error("Resend", res.status); return json({ ok: false, error: "We couldn't send the email. Check the address and try again." }); }
    } catch (e) {
      console.error("Resend", String(e).slice(0, 120));
      return json({ ok: false, error: "We couldn't send the email right now. Please try again." });
    }
    return json({ ok: true, supported: !!r.supported });
  }

  if (body.action === "confirm") {
    const t = String(body.token || "");
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(t)) return json({ ok: false, error: "This link is not valid." });
    const { data: r, error } = await admin.rpc("student_verify_confirm", { p_user: uid, p_token_hash: await sha256Hex(t) });
    if (error) { console.error("student_verify_confirm", error.message); return json({ ok: false, error: "We couldn't verify your student email. Please try again." }, 500); }
    return json(r);
  }
  return json({ error: "Unknown action." }, 400);
});
