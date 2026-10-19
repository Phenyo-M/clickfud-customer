// Shared helpers for the AI functions (ops-investigate, ops-assistant):
// calling Claude with a timeout, and removing secrets / personal details
// from any text before it is stored or sent anywhere.

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Same rules as public.ops_redact() in the database.
export function redact(v: unknown): string {
  return String(v ?? "")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/eyJ[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]+){0,2}/g, "[token]")
    .replace(/(sb_(publishable|secret)_|sk-ant-|sk-|sk_live_|sk_test_|re_|rk_)[A-Za-z0-9_-]{6,}/g, "[secret]")
    .replace(/(bearer|apikey|api_key|password|passwd|secret|token)(["':= ]+)[^\s"',&]+/gi, "$1$2[redacted]")
    // student numbers (u12345678), then phone / card / ID numbers: 9+ digits, optionally
    // split by single spaces or dashes. Dates, incident IDs (INC-2026-00001) and record
    // IDs are kept, so the AI can still refer to them.
    .replace(/(?<![A-Za-z0-9])[uU][0-9]{8}(?![0-9])/g, "[student number]")
    .replace(/(?<![A-Za-z0-9-])(?![0-9]{4}-[0-9]{2}-[0-9]{2})[+]?[0-9](?:[ -]?[0-9]){8,}(?![A-Za-z0-9-])/g, "[number]");
}

// Redacts every string inside a JSON value (used on AI output before saving).
export function redactDeep<T>(v: T): T {
  if (typeof v === "string") return redact(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x)) as unknown as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = redactDeep(x);
    return o as T;
  }
  return v;
}

export type ClaudeResult = {
  ok: boolean;
  content?: Array<Record<string, unknown>>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: string;
};

// url: only tests point this at a stand-in (ANTHROPIC_API_URL); production uses Anthropic.
export async function callClaude(apiKey: string, body: Record<string, unknown>, timeoutMs = 45000, url?: string): Promise<ClaudeResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url || ANTHROPIC_URL, {
      method: "POST",
      signal: ctl.signal,
      // keys not tied to one Anthropic workspace must name it (secret ANTHROPIC_WORKSPACE_ID, same as fudbot-chat)
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01",
        ...(Deno.env.get("ANTHROPIC_WORKSPACE_ID") ? { "anthropic-workspace-id": Deno.env.get("ANTHROPIC_WORKSPACE_ID")! } : {}) },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (j && j.error && j.error.message) ? String(j.error.message) : `HTTP ${res.status}`;
      return { ok: false, error: `Claude API error: ${redact(msg).slice(0, 300)}`, usage: j.usage };
    }
    return { ok: true, content: j.content || [], stop_reason: j.stop_reason, usage: j.usage || {} };
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    return { ok: false, error: aborted ? `Claude did not answer within ${Math.round(timeoutMs / 1000)} seconds.` : `Could not reach Claude: ${redact(String(e)).slice(0, 200)}` };
  } finally {
    clearTimeout(timer);
  }
}

export function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
