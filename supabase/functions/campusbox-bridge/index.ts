// ============================================================
// CLICKFUD — campusbox-bridge Edge Function
// (Function/secret names below kept as "campusbox"/CAMPUSBOX_* — internal
// infra identifiers, not the product's display name, which is RecessBox.)
//
// clickFud and RecessBox are two separate apps on two separate Supabase
// projects (different auth systems, different signing keys — a clickFud
// session JWT is meaningless to RecessBox's project and vice versa), so
// there is no way to just hand RecessBox a token and have it work.
//
// Instead: this function verifies the caller's REAL clickFud session,
// looks up their REAL profile server-side (never trusts anything the
// client claims about itself), and issues a short-lived, HMAC-signed
// "vouch" — "this verified email really is signed in on clickFud right
// now." RecessBox's own /api/bridge route (see that project) verifies
// the signature + expiry with the SAME shared secret, then uses its own
// service-role key to find-or-create a matching account and log the
// browser into it. The shared secret (CAMPUSBOX_BRIDGE_SECRET) is only
// ever known to these two server-side functions — never sent to, or
// readable by, the browser.
//
// Required secret: CAMPUSBOX_BRIDGE_SECRET (also set on RecessBox's
// side, as the same value — this is what lets each side trust the
// other).
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const bridgeSecret = Deno.env.get("CAMPUSBOX_BRIDGE_SECRET")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function base64url(bytes: Uint8Array) {
  const str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(bridgeSecret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64url(new Uint8Array(sig));
}

// 5 minutes — long enough for the redirect to complete, short enough that
// a leaked/logged token is useless shortly after.
const TOKEN_TTL_MS = 5 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return json({ error: "Please sign in." }, 401);

    const { data: profile, error: profileError } = await userClient
      .from("profiles").select("id, email, name, phone, university, role, student_number")
      .eq("id", userData.user.id).single();
    if (profileError || !profile) return json({ error: "Profile not found." }, 404);
    if (!profile.email) return json({ error: "Your account has no verified email on file." }, 400);
    // RecessBox is for students: only a customer account with a verified UP
    // student email is handed over (never a manager/staff/developer login).
    if (profile.role !== "customer") return json({ error: "RecessBox is only available for student accounts." }, 403);
    const { data: isUp } = await userClient.rpc("is_up_student_email", { p_email: profile.email });
    if (isUp !== true) return json({ error: "RecessBox needs your UP student email." }, 403);

    // Only verified profile details — never a password or clickFud session.
    const payloadObj = {
      email: profile.email,
      fullName: profile.name || "",
      phone: profile.phone || "",
      studentNumber: profile.student_number || "",
      universityName: profile.university || "",
      iat: Date.now(),
      exp: Date.now() + TOKEN_TTL_MS,
    };
    const payloadStr = base64url(new TextEncoder().encode(JSON.stringify(payloadObj)));
    const signature = await sign(payloadStr);
    const token = `${payloadStr}.${signature}`;

    return json({ token });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong preparing the RecessBox link." }, 500);
  }
});
