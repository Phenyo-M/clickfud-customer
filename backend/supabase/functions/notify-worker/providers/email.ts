// Email: hands the job to the existing email queue (email_outbox ->
// send-email -> Resend), which has its own retries and delivery status.
// The outbox id is kept as the provider id; sync_email_job_status() moves
// the job to delivered / dead when the outbox row changes.
import { type Provider, str } from "./types.ts";

const KINDS: Record<string, string> = {
  order_ready: "order_ready",
  order_collected: "order_collected",
  order_cancelled: "order_cancelled",
};

export const email: Provider = {
  batch: 10,
  async send(job, admin) {
    const kind = KINDS[job.event_type];
    if (!kind) return { ok: false, skip: true, error: `No email for ${job.event_type}` };
    const p = job.payload || {};
    const { data: prof, error: pe } = await admin.from("profiles").select("email, name").eq("id", job.recipient_id).maybeSingle();
    if (pe) return { ok: false, error: pe.message };
    if (!prof || !str(prof.email)) return { ok: false, skip: true, error: "No email address on file" };

    let items: unknown[] = [], total: unknown = null, shopName = "";
    if (p.order_id) {
      const { data: o } = await admin.from("orders").select("items, total, store_id").eq("id", str(p.order_id)).maybeSingle();
      if (o) {
        items = Array.isArray(o.items) ? o.items : [];
        total = o.total;
        const { data: s } = await admin.from("stores").select("name").eq("id", o.store_id).maybeSingle();
        shopName = s ? str(s.name) : "";
      }
    }
    const { data: id, error } = await admin.rpc("queue_email", {
      p_kind: kind, p_target_type: "order", p_target: p.order_id || null, p_user: job.recipient_id,
      p_email: str(prof.email), p_name: str(prof.name) || null,
      p_data: { order_number: p.order_number, message: p.message, items, total, shop_name: shopName },
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, providerMessageId: `email_outbox:${id}` };
  },
};
