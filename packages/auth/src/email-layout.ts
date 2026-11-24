// The one email layout (E1, restyled to Mint Pill in step 16 B75): every email is HTML plus plain text saying the same thing. No template engine: a table
// layout with inline CSS (Gmail, Outlook and Apple Mail), at most 560 px wide, a plain text wordmark (no logo until the designs exist), one heading,
// short paragraphs, one button for the main link (no raw link in the HTML: the engineer, 19 Nov; the text version keeps it), and a footer saying why the person got the email.
// Colours and fonts are the NS2 design tokens (step16/PLAN.md section 8). Outfit and DM Sans are named first with system fallbacks; no web font is loaded
// (Gmail drops it and the request would tell a remote server the email was opened), so most inboxes show the fallback.
// Every value is HTML-escaped here; callers pass only https links on our own origins (each caller checks its origin).
// Stands alone (no imports) so the outbox command can load it with plain node.
export const SITE_WORDMARK = "IrishWorkPermit.ie"; // as packages/ui cx.ts draws it (brand.test.ts)
export const SITE_NAME = "Irish Work Permit"; // the brand (#289, on irishworkpermit.ie); brevo.ts SENDER_NAME is the same (a test holds them equal)

export type Email = { subject: string; text: string; html: string };
export type Part = { heading: string; paragraphs: string[]; button?: { label: string; url: string }; footer: string; footerLink?: { label: string; url: string }; extra?: { html: string; text: string } };

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);
/** A link for an href: http(s) only (never javascript: or data:), escaped. */
export const href = (url: string) => {
  if (!/^https?:\/\/[^\s]+$/.test(url)) throw new Error("email link refused: not an http(s) address");
  return esc(url);
};

/** The designer's kit colours an email uses (packages/ui/src/tokens.css; hex only: inline CSS has no variables). `link` is the kit's mint-ink: mint text is
 * under AA on the card. `green` is mint one step darker, as in tokens.css, so the button's white text passes. */
export const C = { ink: "#14142B", green: "#0E8655", link: "#0A6B43", lilac: "#DCD6FF", line: "#D8D5EE", surface: "#F6F6FA", onDark: "#E8F3EC", darkCard: "#24244A", critical: "#D9F5E7", criticalInk: "#0A6B43", sponsor: "#E9E5FF", sponsorInk: "#4A32C4", white: "#ffffff" };
const SYS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const FONT = `font-family:'DM Sans',${SYS}`;
export const HFONT = `font-family:Outfit,'Avenir Next',Avenir,${SYS}`;
const P = `margin:0 0 16px;font-size:16px;line-height:25px;color:${C.ink};${FONT}`;
export const pHtml = (s: string, style = P) => `<p style="${style}">${esc(s)}</p>`;
export const SMALL = `margin:0 0 12px;font-size:13.5px;line-height:20px;color:${C.ink};${FONT}`;
const SMALL_ON_DARK = `margin:0 0 8px;font-size:13px;line-height:19px;color:${C.onDark};${FONT}`;
export const linkHtml = (url: string, label = url) => `<a href="${href(url)}" style="color:${C.link};text-decoration:underline;word-break:break-all">${esc(label)}</a>`;
/** A pill holding one key word (NS2: "Pills hold the key word only"). `bg` and `ink` are tokens. */
export const pillHtml = (label: string, bg: string, ink: string = C.ink) =>
  `<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:${bg};font-size:12px;font-weight:600;color:${ink}">${esc(label)}</span>`;

export function render(subject: string, { heading, paragraphs, button, footer, footerLink, extra }: Part): Email {
  const btn = button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 16px"><tr><td class="btn" style="border-radius:999px;background:${C.green}">` +
      `<a href="${href(button.url)}" style="display:inline-block;padding:12px 26px;font-size:16px;font-weight:600;color:${C.white};text-decoration:none;border-radius:999px;${FONT}">${esc(button.label)}</a>` +
      `</td></tr></table>`
    : "";
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(subject)}</title>` +
    `<style>@media (prefers-color-scheme: dark){.bg{background:${C.ink} !important}.card{background:${C.darkCard} !important}.card p,.card h1,.card td{color:${C.surface} !important}.card a{color:${C.lilac} !important}.card .btn,.card .btn a{background:${C.lilac} !important;color:${C.ink} !important}}</style></head>` +
    `<body style="margin:0;padding:0;background:${C.white}"><table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.white}"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;border-radius:16px;overflow:hidden">` +
    `<tr><td class="card" style="padding:28px 28px 24px;background:${C.surface};border-radius:16px 16px 0 0;${FONT}">` +
    `<p style="margin:0 0 20px;font-size:19px;font-weight:600;color:${C.green};${HFONT}">${esc(SITE_WORDMARK)}</p>` +
    `<h1 style="margin:0 0 16px;font-size:24px;line-height:31px;font-weight:600;color:${C.ink};${HFONT}">${esc(heading)}</h1>` +
    paragraphs.map((s) => pHtml(s)).join("") + (extra?.html ?? "") + btn + `</td></tr>` +
    `<tr><td style="padding:20px 28px;background:${C.ink};border-radius:0 0 16px 16px;${FONT}">${pHtml(footer, SMALL_ON_DARK)}` +
    (footerLink ? `<p style="${SMALL_ON_DARK}"><a href="${href(footerLink.url)}" style="color:${C.lilac};text-decoration:underline">${esc(footerLink.label)}</a></p>` : "") +
    `</td></tr></table></td></tr></table></body></html>`;
  const text = [`${SITE_NAME}\n`, heading, "", ...paragraphs.flatMap((s) => [s, ""]), ...(extra ? [extra.text, ""] : []),
    ...(button ? [`${button.label}: ${button.url}`, ""] : []), "--", footer, ...(footerLink ? [`${footerLink.label}: ${footerLink.url}`] : []), ""].join("\n");
  return { subject, text, html };
}
