// The one domain check (Q13, #186), with no imports so the domain seed command can run it under plain node. Re-exported by account-review.ts.

// ponytail: a short fixed list of free and consumer email providers, mostly the ones Irish applicants use. It misses new or regional providers; when one
// slips through, a reviewer simply does not tick "add domain". Swap in a maintained list (disposable and free-mail data) if reviewers ever need help here.
export const FREE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "outlook.ie", "hotmail.com", "hotmail.ie", "hotmail.co.uk", "hotmail.fr", "outlook.co.uk", "live.com", "live.ie", "msn.com",
  "yahoo.com", "yahoo.ie", "yahoo.co.uk", "yahoo.co.in", "rediffmail.com", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me",
  "gmx.com", "gmx.net", "gmx.de", "web.de", "qq.com", "163.com", "tutanota.com", "fastmail.com", "mail.com", "zoho.com", "yandex.com", "eircom.net", "iol.ie", "btinternet.com", "sky.com",
]);
export const isFreeEmailDomain = (domain: string) => FREE_EMAIL_DOMAINS.has(domain);
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
/**
 * The one check for a domain saved to organisation_domain (approve, the domains route, the domain seed): a plain lower-case ASCII host name of two or
 * more labels (no scheme, path, port, space or upper case), each label at most 63 characters, not an IP address (a numeric last label), no punycode
 * label (`xn--`, which can spell a look-alike of a real name), and not a free email provider. Returns the refusal code, or null when the domain is fine.
 */
export function domainProblem(d: unknown): "bad_domain" | "free_email_domain" | null {
  if (typeof d !== "string" || d.length > 253 || !DOMAIN.test(d)) return "bad_domain";
  const labels = d.split(".");
  if (labels.some((l) => l.length > 63 || l.startsWith("xn--")) || /^[0-9]+$/.test(labels.at(-1)!)) return "bad_domain";
  return isFreeEmailDomain(d) ? "free_email_domain" : null;
}
