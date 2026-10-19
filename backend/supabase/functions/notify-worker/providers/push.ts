// Phone push (Web Push with VAPID). Keys live in Edge Function secrets:
// VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT. A device the push
// service no longer accepts is marked invalid; if no device is left, an
// important event falls back to email (queue_notification_fallback).
import webpush from "npm:web-push@3.6.7";
import { type Provider, str } from "./types.ts";

const pub = Deno.env.get("VAPID_PUBLIC_KEY") || "";
const priv = Deno.env.get("VAPID_PRIVATE_KEY") || "";
const subject = Deno.env.get("VAPID_SUBJECT") || "https://clickfood.co.za";
let ready = false;
try { if (pub && priv) { webpush.setVapidDetails(subject, pub, priv); ready = true; } } catch (_) { ready = false; }

export const push: Provider = {
  batch: 30,
  async send(job, admin) {
    if (!ready) return { ok: false, error: "Push keys are not set (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)." };
    const p = job.payload || {};
    const { data: subs, error } = await admin.from("push_subscriptions")
      .select("id, endpoint, p256dh, auth").eq("user_id", job.recipient_id).is("invalid_at", null);
    if (error) return { ok: false, error: error.message };
    if (!subs || !subs.length) return { ok: false, skip: true, error: "No phone with alerts turned on", fallback: "email" };

    const body = str(p.message);
    const payload = JSON.stringify({
      title: str(p.title) || "ClickFood",
      body: body.length > 180 ? body.slice(0, 177) + "..." : body,
      tag: "order-" + str(p.order_id) + "-" + job.event_type,
      data: { route: "orders", orderId: str(p.order_id) || null, type: str(p.type) },
    });

    let sent = 0, gone = 0;
    const errors: string[] = [];
    for (const sub of subs) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 3600 });
        sent++;
      } catch (err) {
        const code = err && typeof err === "object" && "statusCode" in err ? Number((err as { statusCode: number }).statusCode) : 0;
        if ([401, 403, 404, 410].includes(code)) {
          // expired, unsubscribed, or made with old keys
          await admin.from("push_subscriptions").update({ invalid_at: new Date().toISOString() }).eq("id", sub.id);
          gone++;
        } else {
          errors.push(code ? `HTTP ${code}` : String(err).slice(0, 120));
        }
      }
    }
    if (sent) return { ok: true, providerMessageId: `push:${sent}/${subs.length}` };
    if (gone === subs.length) return { ok: false, skip: true, error: "Every phone's alert subscription has expired", fallback: "email" };
    return { ok: false, error: errors.join("; ") || "Push failed" };
  },
};
