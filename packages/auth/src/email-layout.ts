// The one email layout (E1): every email is HTML plus plain text saying the same thing. No template engine: a table layout with inline CSS
// (Gmail, Outlook and Apple Mail), system fonts, at most 560 px wide, a plain text header (no logo until the designs exist), one heading,
// short paragraphs, one button for the main link (no raw link in the HTML: the engineer, 19 Nov; the text version keeps it), and a footer saying why the person got the email.
// Every value is HTML-escaped here; callers pass only https links on our own origins (each caller checks its origin).
// Stands alone (no imports) so the outbox command can load it with plain node.
export const SITE_NAME = "irishworkpermit.ie"; // the brand is not decided (#G9): the domain is honest; brevo.ts SENDER_NAME is the same (a test holds them equal)

export type Email = { subject: string; text: string; html: string };
export type Part = { heading: string; paragraphs: string[]; button?: { label: string; url: string }; footer: string; extra?: { html: string; text: string } };

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);
/** A link for an href: http(s) only (never javascript: or data:), escaped. */
export const href = (url: string) => {
  if (!/^https?:\/\/[^\s]+$/.test(url)) throw new Error("email link refused: not an http(s) address");
  return esc(url);
};

export const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const P = `margin:0 0 16px;font-size:16px;line-height:24px;color:#1f2933;${FONT}`;
export const pHtml = (s: string, style = P) => `<p style="${style}">${esc(s)}</p>`;
export const SMALL = `margin:0 0 12px;font-size:13px;line-height:20px;color:#52606d;${FONT}`;
export const linkHtml = (url: string, label = url) => `<a href="${href(url)}" style="color:#0b5394;text-decoration:underline;word-break:break-all">${esc(label)}</a>`;

export function render(subject: string, { heading, paragraphs, button, footer, extra }: Part): Email {
  const btn = button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 16px"><tr><td class="btn" style="border-radius:6px;background:#0b5394">` +
      `<a href="${href(button.url)}" style="display:inline-block;padding:12px 24px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;${FONT}">${esc(button.label)}</a>` +
      `</td></tr></table>`
    : "";
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(subject)}</title>` +
    `<style>@media (prefers-color-scheme: dark){.bg{background:#111418 !important}.card{background:#1c2127 !important}.card p,.card h1,.card td{color:#e4e7eb !important}.card a{color:#8ab4f8 !important}.card .btn,.card .btn a{background:#8ab4f8 !important;color:#111418 !important}}</style></head>` +
    `<body style="margin:0;padding:0;background:#f3f4f6"><table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:8px"><tr><td style="padding:24px 28px">` +
    `<p style="margin:0 0 20px;font-size:15px;font-weight:700;color:#0b5394;${FONT}">${esc(SITE_NAME)}</p>` +
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:30px;font-weight:700;color:#1f2933;${FONT}">${esc(heading)}</h1>` +
    paragraphs.map((s) => pHtml(s)).join("") + (extra?.html ?? "") + btn +
    `<hr style="border:0;border-top:1px solid #e4e7eb;margin:24px 0 16px">${pHtml(footer, SMALL)}` +
    `</td></tr></table></td></tr></table></body></html>`;
  const text = [`${SITE_NAME}\n`, heading, "", ...paragraphs.flatMap((s) => [s, ""]), ...(extra ? [extra.text, ""] : []),
    ...(button ? [`${button.label}: ${button.url}`, ""] : []), "--", footer, ""].join("\n");
  return { subject, text, html };
}
