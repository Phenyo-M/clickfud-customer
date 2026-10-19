// Shared rate limiting for Edge Functions. Counters live in the database
// (public.rl_hit), so every function instance shares them; over the limit the
// caller gets HTTP 429 with Retry-After, and repeat offenders are blocked for
// a while (see rl_hit). The client address comes from the platform's own
// header (cf-connecting-ip, set by Cloudflare in front of Supabase), and only
// a short hash of it is stored.

// deno-lint-ignore no-explicit-any
type Admin = any;

export async function clientKey(req: Request): Promise<string | null> {
  // only Cloudflare's header: X-Forwarded-For's first entry can be set by the caller
  const ip = (req.headers.get("cf-connecting-ip") || "").trim();
  if (!ip) return null;
  return "ip:" + (await sha16("clickfood-rl:" + ip));
}

export async function sha16(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

// Returns null when allowed, or a 429 Response to send back. If the limiter
// itself can't be reached the request is allowed (logins and payments must not
// stop because of the limiter) and the problem shows up in monitoring.
export async function limited(admin: Admin, key: string | null, endpoint: string, max: number, windowSeconds: number,
                              headers: Record<string, string>, message = "Too many requests. Please wait a moment and try again."): Promise<Response | null> {
  if (!key) return null;
  try {
    const { data, error } = await admin.rpc("rl_hit", { p_key: key, p_endpoint: endpoint, p_limit: max, p_window_seconds: windowSeconds });
    if (error || !data || data.allowed !== false) return null;
    const retry = Math.max(1, Number(data.retry_after) || 60);
    return new Response(JSON.stringify({ error: message, retry_after: retry, rate_limited: true }), {
      status: 429, headers: { ...headers, "Content-Type": "application/json", "Retry-After": String(retry) },
    });
  } catch (_) {
    return null;
  }
}
