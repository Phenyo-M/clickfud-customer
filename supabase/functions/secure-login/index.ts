// ============================================================
// CLICKFUD — secure-login Edge Function
//
// Wraps Supabase's own password sign-in so failed attempts can be counted
// and locked out per email — something no RLS policy or trigger on our
// own tables can do, since a login attempt happens before anyone is
// authenticated. After 5 failed attempts for an email, further attempts
// are rejected for 15 minutes without even calling Auth again. A
// successful login clears the counter.
//
// The service-role key is required here (not the anon key) because it's
// the only way to read/write login_attempts, whose RLS is default-deny
// for every client role — this function is the sole path to that table.
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

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
    const { email, password } = await req.json();
    const cleanEmail = String(email || "").trim().toLowerCase();
    if (!cleanEmail || !password) {
      return json({ error: "Email and password are required." });
    }

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
      // A lockout that already expired naturally resets the count, rather
      // than the very next failure immediately re-locking for 15 more
      // minutes off a stale count.
      const lockoutExpired = attempt && attempt.locked_until && new Date(attempt.locked_until) <= now;
      const baseCount = attempt && !lockoutExpired ? attempt.failed_count : 0;
      const newCount = baseCount + 1;

      const patch: Record<string, unknown> = {
        email: cleanEmail,
        failed_count: newCount,
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

    // Success — clear any prior failed-attempt record for this email.
    await supabase.from("login_attempts").delete().eq("email", cleanEmail);

    return json({ session: authData.session, user: authData.user });
  } catch (e) {
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
