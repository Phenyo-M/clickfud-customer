// SMS: built but switched off (2026-10-13, the user chose to leave SMS for
// now). No channel rule creates SMS jobs and every user's SMS preference
// defaults to off. To switch it on later: pick a provider (SMSPortal,
// WinSMS, BulkSMS, Clickatell or Twilio), set SMS_PROVIDER + its API key
// secrets, fill in sendWith() below, add sms rows to
// notification_channel_rules, and verify phone numbers first.
import { type Provider, str } from "./types.ts";

const PROVIDER = Deno.env.get("SMS_PROVIDER") || "";

async function sendWith(_to: string, _text: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  return { ok: false, error: `SMS provider "${PROVIDER || "none"}" is not set up yet.` };
}

export const sms: Provider = {
  batch: 5,
  async send(job, admin) {
    if (!PROVIDER) return { ok: false, skip: true, error: "SMS is switched off" };
    const { data: prof } = await admin.from("profiles").select("phone").eq("id", job.recipient_id).maybeSingle();
    const to = prof ? str(prof.phone) : "";
    if (!to) return { ok: false, skip: true, error: "No phone number on file" };
    const text = str(job.payload && job.payload.message).slice(0, 160);
    const r = await sendWith(to, text);
    return r.ok ? { ok: true, providerMessageId: r.id || null } : { ok: false, error: r.error || "SMS failed" };
  },
};
