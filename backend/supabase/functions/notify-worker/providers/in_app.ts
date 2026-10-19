// In app: a row in public.notifications. The app shows it straight away
// through Realtime and marks the job delivered when it reaches the screen.
// job_id is unique, so a job retried after a crash never shows twice.
import { type Provider, str } from "./types.ts";

export const inApp: Provider = {
  batch: 50,
  async send(job, admin) {
    const p = job.payload || {};
    const message = str(p.message).slice(0, 600);
    if (!message) return { ok: false, skip: true, error: "Empty message" };
    const { data, error } = await admin.from("notifications")
      .upsert({ user_id: job.recipient_id, message, type: str(p.type) || "info", job_id: job.id },
              { onConflict: "job_id", ignoreDuplicates: true })
      .select("id");
    if (error) return { ok: false, error: error.message };
    let id = data && data[0] && data[0].id;
    if (!id) {
      const { data: existing, error: e2 } = await admin.from("notifications").select("id").eq("job_id", job.id).maybeSingle();
      if (e2 || !existing) return { ok: false, error: e2 ? e2.message : "Notification not saved" };
      id = existing.id;
    }
    return { ok: true, providerMessageId: id };
  },
};
