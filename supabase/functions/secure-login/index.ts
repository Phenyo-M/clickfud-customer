// ============================================================
// CLICKFUD — secure-login Edge Function
//
// Wraps Supabase's own password sign-in so failed attempts can be counted
// and locked out per email — something no RLS policy or trigger on our
// own tables can do, since a login attempt happens before anyone is
// authenticated. After 5 failed attempts for an email WITHIN A ROLLING
// 10-MINUTE WINDOW, further attempts are rejected for 15 minutes without
// even calling Auth again. A successful login clears the record entirely.
//
// FIX (2026-09-24): the previous version kept a single failed_count that
// only ever reset on a successful login or once an active lockout expired
// — meaning failures with no relation to each other, spread across DAYS,
// silently accumulated into a lockout that then appeared to trigger out
// of nowhere on what felt like a first attempt. Confirmed live: a real
// account had failed_count=5 built from attempts days apart. Now each
// failure's timestamp is kept (attempt_times, capped to the last 10
// minutes on every check), and only failures still inside that rolling
// window count toward the threshold — old, unrelated failures roll off
// on their own instead of compounding forever.
//
// The service-role key is required here (not the anon key) because it's
// the only way to read/write login_attempts, whose RLS is default-deny
// for every client role — this function is the sole path to that table.
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MAX_ATTEMPTS = 5;
const WINDOW_MINUTES = 10;
const LOCKOUT_MINUTES = 15;

// This ONE deployed function is shared by all three clickFud frontends
// (customer, staff, developer — separate codebases, one Supabase
// project), each invoking it with its own `app` value so it knows which
// account roles actually belong here. A previous version of this file
// hardcoded "must be role customer", forgetting this function is shared
// — which meant every real staff/developer login started failing the
// moment that version was deployed, even with correct credentials.
// Never trust ROLES_BY_APP with anything a real account doesn't already
// have: this only narrows which of an ACCOUNT'S OWN real role is
// accepted for a given app, it can't grant a role nobody has.
const ROLES_BY_APP: Record<string, string[]> = {
  customer: ["customer"],
  staff: ["manager", "kitchen", "driver", "dispatcher"],
  developer: ["developer"],
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { email, password, app } = await req.json();
    const cleanEmail = String(email || "").trim().toLowerCase();
    if (!cleanEmail || !password) {
      return json({ error: "Email and password are required." });
    }
    // Defaults to the customer app's own rule if a caller ever omits
    // `app` (e.g. a stale cached frontend build) — never to "allow any
    // role", which would silently undo the whole point of this check.
    const allowedRoles = ROLES_BY_APP[String(app || "customer")] || ROLES_BY_APP.customer;

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const now = new Date();

    const { data: attempt } = await supabase
      .from("login_attempts")
      .select("*")
      .eq("email", cleanEmail)
      .maybeSingle();

    if (attempt && attempt.locked_until && new Date(attempt.locked_until) > now) {
      const minsLeft = Math.max(1, Math.ceil((new Date(attempt.locked_until).getTime() - now.getTime()) / 60000));
      return json({
        error: `Too many failed attempts. Please try again in ${minsLeft} minute(s).`,
        lockedUntil: attempt.locked_until,
      });
    }

    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: cleanEmail,
      password,
    });

    if (authError) {
      // Only failures still inside the last WINDOW_MINUTES count toward
      // the threshold — anything older has rolled off on its own, exactly
      // like a real rolling window, regardless of whether this email was
      // ever locked out before.
      const windowStart = now.getTime() - WINDOW_MINUTES * 60000;
      const priorTimes: string[] = attempt && Array.isArray(attempt.attempt_times) ? attempt.attempt_times : [];
      const recentTimes = priorTimes.filter((t) => new Date(t).getTime() >= windowStart);
      recentTimes.push(now.toISOString());
      const newCount = recentTimes.length;

      const patch: Record<string, unknown> = {
        email: cleanEmail,
        failed_count: newCount,
        // Once locked, the next streak starts clean after the lockout
        // expires rather than immediately re-triggering off leftover
        // timestamps from the streak that just got locked.
        attempt_times: newCount >= MAX_ATTEMPTS ? [] : recentTimes,
        updated_at: now.toISOString(),
        locked_until: newCount >= MAX_ATTEMPTS ? new Date(now.getTime() + LOCKOUT_MINUTES * 60000).toISOString() : null,
      };
      await supabase.from("login_attempts").upsert(patch);

      if (newCount >= MAX_ATTEMPTS) {
        return json({
          error: `Too many failed attempts. Please try again in ${LOCKOUT_MINUTES} minute(s).`,
          lockedUntil: patch.locked_until,
        });
      }
      return json({ error: authError.message });
    }

    // A correct password for an account whose role doesn't belong to
    // THIS calling app must still never actually sign in here — e.g. a
    // manager's real credentials, entered on the customer app. Previously
    // this was allowed through and only caught afterwards by the client
    // showing a "wrong app, sign in over here instead" screen — which is
    // itself a real information leak (it confirms a valid account exists
    // for that email, and tells an attacker which other app/URL to go try
    // it against). Checked here instead, before any session is ever
    // handed back to the browser, and reported back with the exact same
    // wording Supabase's own bad-password error uses ("Invalid login
    // credentials") so the two cases are indistinguishable client-side —
    // the existing friendlyError() mapping in each app's own js/auth.js
    // already turns that into "Incorrect email or password."
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", authData.user.id)
      .maybeSingle();
    if (profile && !allowedRoles.includes(profile.role)) {
      return json({ error: "Invalid login credentials" });
    }

    // Customer app only: a CUSTOMER account must use an approved University
    // of Pretoria student email (supabase/up_student_auth.sql). New accounts
    // can't be created without one; this also stops any older non-UP
    // customer account from signing in. The domain list lives in ONE place
    // — public.is_up_student_email() — never duplicated here. Staff and
    // developer apps (app != "customer") and every non-customer role are
    // untouched. Only reached after a correct password, so this message
    // can't be used to probe which emails have accounts.
    if (String(app || "customer") === "customer" && profile && profile.role === "customer") {
      const { data: isUp, error: upError } = await supabase.rpc("is_up_student_email", { p_email: authData.user.email });
      if (upError || isUp !== true) {
        return json({ error: "Please use your University of Pretoria student email address to sign in.", notUpStudent: true });
      }
    }

    // Success — clear any prior failed-attempt record for this email.
    await supabase.from("login_attempts").delete().eq("email", cleanEmail);

    return json({ session: authData.session, user: authData.user });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
