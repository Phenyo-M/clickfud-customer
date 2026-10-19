// notify-worker: delivers queued order notifications (public.notification_jobs).
//
// Woken by the database right after an order change (kick_notification_worker,
// via pg_net) and every 15 seconds by pg_cron while jobs are due (retries).
// For each channel it claims a batch with claim_notification_jobs (FOR UPDATE
// SKIP LOCKED; preferences and stale jobs are handled there), sends each job
// through that channel's provider, and records the result with
// finish_notification_job (sent, or failed with backoff, dead after 5 tries).
//
// Only the database may call it: header x-worker-secret must equal the
// NOTIFY_WORKER_SECRET secret. Deploy with --no-verify-jwt.
import { createClient } from "npm:@supabase/supabase-js@2";
import type { Job, Provider, SendResult } from "./providers/types.ts";
import { inApp } from "./providers/in_app.ts";
import { push } from "./providers/push.ts";
import { email } from "./providers/email.ts";
import { sms } from "./providers/sms.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const workerSecret = Deno.env.get("NOTIFY_WORKER_SECRET") || "";

// Adding a channel = adding a provider here; the loop below never changes.
const PROVIDERS: Record<string, Provider> = { in_app: inApp, push, email, sms };

function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!safeEqual(req.headers.get("x-worker-secret") || "", workerSecret)) return json({ error: "Not allowed" }, 401);

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const report: Record<string, { sent: number; failed: number; skipped: number }> = {};

  for (const [channel, provider] of Object.entries(PROVIDERS)) {
    const counts = { sent: 0, failed: 0, skipped: 0 };
    report[channel] = counts;
    const { data: jobs, error } = await admin.rpc("claim_notification_jobs", { p_channel: channel, p_limit: provider.batch });
    if (error) { console.error("claim", channel, error.message); continue; }
    for (const job of (jobs || []) as Job[]) {
      let r: SendResult;
      try {
        r = await provider.send(job, admin);
      } catch (e) {
        r = { ok: false, error: String(e && (e as Error).message || e).slice(0, 300) };
      }
      const { error: fe } = await admin.rpc("finish_notification_job", {
        p_id: job.id, p_ok: !!r.ok, p_provider_id: r.providerMessageId || null,
        p_error: r.ok ? null : (r.error || "Unknown error"), p_skip: !!r.skip,
      });
      if (fe) console.error("finish", job.id, fe.message);
      if (r.fallback) await admin.rpc("queue_notification_fallback", { p_job: job.id, p_channel: r.fallback });
      if (r.ok) counts.sent++; else if (r.skip) counts.skipped++; else counts.failed++;
    }
  }
  return json({ ok: true, report });
});
