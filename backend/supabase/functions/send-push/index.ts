// ============================================================
// CLICKFOOD — send-push Edge Function
//
// Sends a Web Push notification to every device a given user has
// subscribed from (push_subscriptions table). Order alerts now go through
// notify-worker; this stays for manual server-side sends only.
// LOCKED (2026-10-13): it used to accept any caller with the public app
// key, so anyone could push any text to any user. It now needs header
// x-worker-secret = NOTIFY_WORKER_SECRET, which no browser has.
//
// Required secrets (set via `supabase secrets set`):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto: or https: URL)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically
// by the Supabase Edge Runtime.
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY") || "";
const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY") || "";
const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "https://clickfud-customer.vercel.app";

const workerSecret = Deno.env.get("NOTIFY_WORKER_SECRET") || "";
let vapidReady = false;
try { if (vapidPublicKey && vapidPrivateKey) { webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey); vapidReady = true; } } catch (_) { vapidReady = false; }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const given = req.headers.get("x-worker-secret") || "";
  if (!workerSecret || given.length !== workerSecret.length || given !== workerSecret) {
    return new Response(JSON.stringify({ error: "Not allowed" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (!vapidReady) {
    return new Response(JSON.stringify({ error: "Push keys are not set" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  try {
    const { userId, title, body, tag, data } = await req.json();
    if (!userId || !title || !body) {
      return new Response(JSON.stringify({ error: "userId, title and body are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: subs, error } = await supabase
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("user_id", userId);

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payload = JSON.stringify({
      title,
      body,
      tag: tag || "clickfud",
      data: data || {},
    });

    let sent = 0;
    let cleaned = 0;
    await Promise.all((subs || []).map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        sent++;
      } catch (err) {
        // 404/410 means the browser's push service no longer recognises this
        // subscription (uninstalled, expired, permission revoked elsewhere) —
        // delete it so we stop trying and it never piles up.
        const statusCode = err && typeof err === "object" && "statusCode" in err ? (err as { statusCode: number }).statusCode : null;
        if (statusCode === 404 || statusCode === 410) {
          await supabase.from("push_subscriptions").delete().eq("id", sub.id);
          cleaned++;
        } else {
          console.error("push send failed", sub.id, err);
        }
      }
    }));

    return new Response(JSON.stringify({ ok: true, sent, cleaned, total: (subs || []).length }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
