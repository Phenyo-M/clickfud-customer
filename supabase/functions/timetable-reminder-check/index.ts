// ============================================================
// CLICKFUD — timetable-reminder-check Edge Function
//
// Triggered every minute by a pg_cron job (see migration_governance.sql
// section 46) — never called by the browser. Its only job: ask
// claim_due_timetable_reminders() which classes start in 9-11 minutes
// and haven't already had a reminder sent for today's occurrence, then
// send each one a real push notification via the existing send-push
// function (same one used for order notifications).
//
// This is what makes "works with the app closed/backgrounded/phone
// locked" true — a Web Push notification is delivered by the OS/browser
// push service independently of whether the app is open at all (see
// sw.js), and firing is driven by this server-side schedule, never by
// anything running only while a tab is open.
//
// Reliability: because claim_due_timetable_reminders() computes "what's
// due" fresh from live timetable_entries on every single tick, editing
// a class's time/venue/day, or deleting it, is automatically reflected
// on the very next tick — there is no separately-stored "scheduled
// reminder" object that could go stale. Its own INSERT ... ON CONFLICT
// DO NOTHING ... RETURNING is what guarantees a given class occurrence
// is only ever claimed (and therefore only ever pushed) once, even if
// two ticks overlap.
//
// Auth: this function intentionally does NOT use a Supabase user JWT —
// nothing about it is triggered by a signed-in browser session. It's
// deployed with --no-verify-jwt and instead checks a small shared
// secret header the pg_cron job itself sends, generated fresh for this
// feature (never an existing Paystack/Supabase credential).
//
// Required secrets:
//   CRON_SHARED_SECRET — matches what the pg_cron job sends in
//   x-cron-secret. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are
//   provided automatically by the Edge Runtime.
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cronSharedSecret = Deno.env.get("CRON_SHARED_SECRET") || "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function formatTime(t: string) {
  // Postgres `time` comes back as "HH:MM:SS[.ffffff]" — trim to "HH:MM".
  return String(t).slice(0, 5);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const provided = req.headers.get("x-cron-secret") || "";
  if (!cronSharedSecret || provided !== cronSharedSecret) {
    return json({ error: "unauthorized" }, 401);
  }

  try {
    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data: due, error } = await admin.rpc("claim_due_timetable_reminders");
    if (error) return json({ error: error.message }, 500);

    let sent = 0;
    for (const row of due || []) {
      const startLabel = formatTime(row.out_start_time);
      const body = `${row.out_module}\n${startLabel} • ${row.out_venue}, ${row.out_campus} Campus`;
      try {
        await fetch(`${supabaseUrl}/functions/v1/send-push`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: row.out_student_id,
            title: "🔔 Your next class is in 10 minutes",
            body,
            tag: `timetable-${row.entry_id}-${row.out_occurrence_date}`,
            data: {
              type: "timetable_reminder",
              timetableEntryId: row.entry_id,
              route: "timetable",
            },
          }),
        });
        sent++;
      } catch (e) {
        console.error("send-push call failed for timetable reminder", row.entry_id, e);
      }
    }

    return json({ ok: true, checked: (due || []).length, sent });
  } catch (e) {
    console.error(e);
    return json({ error: "server_error" }, 500);
  }
});
