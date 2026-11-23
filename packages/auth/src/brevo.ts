// The real email sender: one call to Brevo's transactional email API through fetch (no SDK).
// API: POST https://api.brevo.com/v3/smtp/email, key in the `api-key` header, body sender { name, email }, to, subject, htmlContent, textContent
// (https://developers.brevo.com/reference/sendtransacemail and https://developers.brevo.com/docs/send-a-transactional-email).
// Optional custom headers go in the body's `headers` map (Title-Case names). Brevo's reference says "Standard email headers are not supported",
// and Brevo adds its own mandatory List-Unsubscribe header to every transactional email (help.brevo.com article 19100260472850), so the job
// alert's own List-Unsubscribe may be ignored or replaced; E1 report, step15/emails-report.md, has what a click on Brevo's does.
// Stands alone (no imports) so the outbox command can load it with plain node.
export type SendMail = (to: string, subject: string, text: string, html: string, headers?: Record<string, string>) => Promise<void>;
export const SENDER_NAME = "Irish Work Permit"; // the From name (brand decided, #289); EMAIL_FROM stays one plain address
export type BrevoOptions = { apiKey: string; from: string; fetch?: typeof fetch; timeoutMs?: number };

export const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
export const BREVO_TIMEOUT_MS = 10_000;
const ADDRESS = /^[^\s@<>,;"()[\]\\]{1,64}@[A-Za-z0-9.-]{1,255}$/; // one plain address; no names, lists or header tricks
export const isAddress = (s: string) => s.length <= 254 && ADDRESS.test(s);

/** Every failure is a thrown Error whose message holds only the status or reason: never the key, the address or the body we sent. */
export function createBrevoMail({ apiKey, from, fetch: f = fetch, timeoutMs = BREVO_TIMEOUT_MS }: BrevoOptions): SendMail {
  if (!apiKey) throw new Error("BREVO_API_KEY is empty.");
  if (!isAddress(from)) throw new Error("EMAIL_FROM must be one plain address such as no-reply@example.com.");
  return async (to, subject, text, html, headers) => {
    if (!isAddress(to)) throw new Error("Brevo send refused: the recipient is not a plain address.");
    if (headers && Object.entries(headers).some(([k, v]) => !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(k) || /[\r\n]/.test(v)))
      throw new Error("Brevo send refused: a header name or value is not allowed.");
    let res: Response;
    try {
      res = await f(BREVO_URL, {
        method: "POST",
        headers: { "api-key": apiKey, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ sender: { name: SENDER_NAME, email: from }, to: [{ email: to }], subject, htmlContent: html, textContent: text, ...(headers && Object.keys(headers).length ? { headers } : {}) }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error", // a redirect would carry the key header elsewhere
      });
    } catch (e) {
      throw new Error(`Brevo send failed: ${(e as Error).name === "TimeoutError" ? "timeout" : "network error"}`);
    }
    if (res.status === 201 || res.status === 202) return;
    const code = await res.json().then((j: { code?: unknown }) => (typeof j.code === "string" ? j.code.slice(0, 40).replace(/[^\w]/g, "") : ""), () => "");
    throw new Error(`Brevo send failed: HTTP ${res.status}${code ? ` ${code}` : ""}`);
  };
}
