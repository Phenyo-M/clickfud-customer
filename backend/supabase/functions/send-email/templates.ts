// Email templates for ClickFood's automatic emails. Each kind has its own
// subject, steps and link; render() turns one into plain text + HTML.
// Values come from the email_outbox row (trusted database data); a
// missing name falls back to "there", never to a raw placeholder.

export const CUSTOMER_APP_URL = "https://clickfood.co.za";
export const STAFF_APP_URL = "https://manager.clickfood.co.za";

export type OutboxRow = {
  id: string;
  kind: string;
  recipient_email: string;
  recipient_name: string | null;
  data: Record<string, unknown> | null;
};

type Template = {
  subject: (v: Vars) => string;
  intro: (v: Vars) => string;
  steps: (v: Vars) => string[];
  note?: (v: Vars) => string;
  button: { label: string; url: string };
  heading?: string;
  footer?: string;
};
type Vars = { first: string; shop: string; data: Record<string, unknown> };
const DEVELOPER_APP_URL = "https://clickfud-developer.vercel.app";
const str = (v: unknown) => String(v ?? "").trim();

const ORDER_FOOTER = "You're receiving this because you ordered on ClickFood. You can turn order emails off in Settings.";

const TEMPLATES: Record<string, Template> = {
  student_shop_approved: {
    subject: (v) => `${v.shop} is approved on ClickFood`,
    intro: (v) => `Good news: ClickFood has approved your student food shop, ${v.shop}.`,
    steps: () => [
      "Open My Shop in the ClickFood app.",
      "Add at least 5 food products with a clear photo, an honest description, the price and any allergens.",
      "ClickFood reviews each product. You can see the status of each one in My Shop.",
      "When 5 products are approved, tap Publish my shop.",
    ],
    note: () => "Your shop is not visible to customers yet. It goes live when you publish it. Buyers pay you directly; ClickFood does not take payment for student food.",
    button: { label: "Open My Shop", url: `${CUSTOMER_APP_URL}/?view=sell` },
  },
  business_shop_approved: {
    subject: (v) => `${v.shop} is approved on ClickFood`,
    intro: (v) => `Congratulations: ClickFood has accepted your business application for ${v.shop}.`,
    steps: () => [
      "Sign in to ClickFood Manager.",
      "Upload your shop logo and a cover photo, and check your opening hours and pickup address.",
      "Add your menu. ClickFood reviews each item before customers can see it.",
      "Send your shop for its final review (Publish request).",
    ],
    note: () => "Your shop is not visible to customers yet. ClickFood takes a final look after your publish request, then your shop goes live.",
    button: { label: "Open ClickFood Manager", url: STAFF_APP_URL },
  },
  business_shop_live: {
    subject: (v) => `${v.shop} is now live on ClickFood`,
    intro: (v) => `Your shop, ${v.shop}, passed its final review and is now live. Students can find it and order from it.`,
    steps: () => [
      "Keep your opening hours and menu up to date in ClickFood Manager.",
      "Watch for new orders on your kitchen board.",
      "Use Busy or Pause if you need a break from new orders.",
    ],
    button: { label: "Open ClickFood Manager", url: STAFF_APP_URL },
  },
  account_deleted_notice: {
    subject: (v) => `${str(v.data.student_first_name) || "A student"} deleted their ClickFood account`,
    intro: (v) => `${str(v.data.student_first_name) || "A student"} deleted their ClickFood account.`,
    steps: (v) => [
      `Reason: ${str(v.data.reason) || "Not given"}`,
      ...(str(v.data.details) ? [`What they said: ${str(v.data.details)}`] : []),
      ...(str(v.data.shop_name) ? [`Their shop ${str(v.data.shop_name)} was closed.`] : []),
    ],
    button: { label: "Open the developer app", url: DEVELOPER_APP_URL },
    heading: "Details",
    footer: "You get this because you are a ClickFood admin.",
  },
  driver_approved: {
    subject: () => "Your ClickFood driver account is approved",
    intro: () => "ClickFood has approved your driver application.",
    steps: () => [
      "Sign in to ClickFood Manager with the email and password you registered with.",
      "Your driver page opens automatically after you sign in.",
    ],
    button: { label: "Sign in", url: STAFF_APP_URL },
  },
  // ---- monitoring alert (ops_alert in ops_monitoring.sql). Brief on purpose:
  // no logs or customer details in email, only where to look.
  ops_alert: {
    subject: (v) => `ClickFood alert: ${str(v.data.severity).toUpperCase()} ${str(v.data.ref)}`,
    intro: (v) => `${str(v.data.ref)}: ${str(v.data.title).slice(0, 140)}`,
    steps: (v) => [`Severity: ${str(v.data.severity)}`, `Why you got this: ${str(v.data.reason)}`],
    button: { label: "Open AI System Analysis", url: `${DEVELOPER_APP_URL}/?view=ai-analysis` },
    heading: "Alert",
    footer: "You get this because you are a ClickFood developer. Details are only in the dashboard.",
  },
  // ---- order emails (queued by notify-worker; data = order_number, items, total, message) ----
  order_ready: {
    subject: (v) => `Order ${str(v.data.order_number)} is ready`,
    intro: (v) => str(v.data.message) || `Your order ${str(v.data.order_number)} from ${v.shop} is ready.`,
    steps: (v) => orderLines(v.data),
    button: { label: "Open ClickFood", url: CUSTOMER_APP_URL },
    heading: "Your order",
    footer: ORDER_FOOTER,
  },
  order_collected: {
    subject: (v) => `Your ClickFood receipt for ${str(v.data.order_number)}`,
    intro: (v) => `Thanks for your order from ${v.shop}. Here is your receipt for ${str(v.data.order_number)}.`,
    steps: (v) => orderLines(v.data),
    note: (v) => `Total: R${money(v.data.total)}`,
    button: { label: "Rate your order", url: CUSTOMER_APP_URL },
    heading: "Receipt",
    footer: ORDER_FOOTER,
  },
  order_cancelled: {
    subject: (v) => `Order ${str(v.data.order_number)} was cancelled`,
    intro: (v) => str(v.data.message) || `Your order ${str(v.data.order_number)} was cancelled.`,
    steps: (v) => orderLines(v.data),
    note: () => "If you paid by card, any refund shows under Orders in the app.",
    button: { label: "Open ClickFood", url: CUSTOMER_APP_URL },
    heading: "What you ordered",
    footer: ORDER_FOOTER,
  },
};

function money(v: unknown): string { return (Number(v) || 0).toFixed(2); }
function orderLines(data: Record<string, unknown>): string[] {
  const items = Array.isArray(data.items) ? data.items as Record<string, unknown>[] : [];
  const lines = items.filter((it) => it && str(it.name)).slice(0, 20)
    .map((it) => `${Number(it.qty) || 1} x ${str(it.name)}: R${money((Number(it.price) || 0) * (Number(it.qty) || 1))}`);
  return lines.length ? lines : [`Order ${str(data.order_number)}`];
}

export function hasTemplate(kind: string): boolean {
  return kind in TEMPLATES;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function render(row: OutboxRow): { subject: string; text: string; html: string } {
  const t = TEMPLATES[row.kind];
  if (!t) throw new Error(`No email template for "${row.kind}".`);
  const data = (row.data || {}) as Record<string, unknown>;
  const first = String(row.recipient_name || "").trim().split(/\s+/)[0] || "there";
  const shop = String(data.shop_name || "").trim() || "your shop";
  const v: Vars = { first, shop, data };
  const heading = t.heading || "Next steps";
  const footer = t.footer || "You're receiving this because you applied on ClickFood.";
  const steps = t.steps(v);
  const note = t.note ? t.note(v) : "";

  const text = [
    `Hi ${first},`, "", t.intro(v), "", `${heading}:`,
    ...steps.map((s, i) => `  ${i + 1}. ${s}`), "",
    ...(note ? [note, ""] : []),
    `${t.button.label}: ${t.button.url}`, "",
    "The ClickFood Team",
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;background:#FDF3DF;font-family:Arial,Helvetica,sans-serif;color:#2B1D14;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FDF3DF;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFCF7;border-radius:16px;padding:28px;">
<tr><td style="font-size:22px;font-weight:800;padding-bottom:16px;">Click<span style="color:#E04A1F;">Food</span></td></tr>
<tr><td style="font-size:16px;line-height:1.55;">
<p style="margin:0 0 12px;">Hi ${esc(first)},</p>
<p style="margin:0 0 16px;">${esc(t.intro(v))}</p>
<p style="margin:0 0 8px;font-weight:700;color:#1B4D2E;">${esc(heading)}</p>
<ol style="margin:0 0 16px;padding-left:20px;">${steps.map((s) => `<li style="margin:0 0 6px;">${esc(s)}</li>`).join("")}</ol>
${note ? `<p style="margin:0 0 20px;padding:12px 14px;background:#FBEAE3;border-radius:10px;font-size:14px;">${esc(note)}</p>` : ""}
<p style="margin:0 0 24px;"><a href="${esc(t.button.url)}" style="display:inline-block;background:#E04A1F;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:999px;">${esc(t.button.label)}</a></p>
<p style="margin:0;color:#6B5A4E;font-size:14px;">The ClickFood Team</p>
</td></tr></table>
<p style="font-size:12px;color:#8A7A6E;margin:14px 0 0;">${esc(footer)}</p>
</td></tr></table></body></html>`;

  return { subject: t.subject(v), text, html };
}
