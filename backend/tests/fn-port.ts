// Test helper: runs an Edge Function on the port in FN_PORT (Supabase's
// runtime picks the port itself; locally Deno.serve would always use 8000).
// FN_ENTRY = file URL of the function's index.ts.
const port = Number(Deno.env.get("FN_PORT") || "8000");
const orig = Deno.serve;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (a: any, b?: any) =>
  typeof a === "function" ? orig({ port, onListen() {} }, a) : orig({ ...a, port, onListen() {} }, b);
await import(Deno.env.get("FN_ENTRY")!);
