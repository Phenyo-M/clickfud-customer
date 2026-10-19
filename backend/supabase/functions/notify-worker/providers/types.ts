// Shared shape for every notification channel. A provider gets one claimed
// job and says what happened; the worker records it (finish_notification_job).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type Job = {
  id: string;
  recipient_id: string;
  channel: "in_app" | "push" | "email" | "sms";
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  dedupe_key: string;
};

export type SendResult = {
  ok: boolean;
  providerMessageId?: string | null;
  error?: string | null;
  // nothing to send to (no device, no email address): not a failure, no retry
  skip?: boolean;
  // for important events, try another channel instead (push -> email)
  fallback?: "email" | "sms";
};

export type Provider = {
  // how many jobs of this channel one worker run sends at most
  batch: number;
  send(job: Job, admin: SupabaseClient): Promise<SendResult>;
};

export const str = (v: unknown) => String(v ?? "").trim();
