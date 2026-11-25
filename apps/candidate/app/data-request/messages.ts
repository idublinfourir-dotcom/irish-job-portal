// What /data-request says when the API answers (GET and POST /api/data-request, docs/openapi/candidate.yaml). Pure text, one sentence per code. An unknown, used,
// expired or closed link is the same INVALID_LINK, so the page cannot say which.
import type { Res } from "../(auth)/messages";

export const INVALID_LINK = "This link has already been used or has ended. If you still want us to act on your request, contact us from the Help page and we will send a new link.";
const BY_CODE: Record<string, string> = {
  BAD_REQUEST: "This link does not work. Open the link in the email again.",
  INVALID_LINK,
  TOO_MANY_REQUESTS: "Too many tries. Wait a few minutes, then open the link again.",
  BAD_ORIGIN: "The page could not confirm where the request came from. Open the link in the email again.",
  BODY_TOO_LARGE: "The request was too large to send. Reload the page and try again.",
};
export function dataRequestSay(r: Res): string {
  if (r.status === 0) return "We could not reach the site. Check your connection and try again.";
  if (r.status === 429) return BY_CODE.TOO_MANY_REQUESTS!;
  const by = BY_CODE[r.code ?? ""];
  if (by) return by;
  return r.status >= 500 ? "Something went wrong on our side. Try again in a few minutes." : "That did not work. Reload the page and try again.";
}
/** The token as the API checks it (43 characters, base64url); the page reads nothing for a link that fails here. */
export const DR_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const parseToken = (t: unknown): string | null => (typeof t === "string" && DR_TOKEN.test(t) ? t : null);
/** "26 Nov 2026 at 09:30", Irish time, from the `expiresAt` the API gives (a Postgres timestamp, so not always ISO: a space may stand for the T). */
export function endsAt(expiresAt: string): string | null {
  const d = new Date(expiresAt.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  if (Number.isNaN(d.getTime())) return null;
  const f = (o: Intl.DateTimeFormatOptions) => d.toLocaleString("en-IE", { timeZone: "Europe/Dublin", ...o });
  return `${f({ day: "numeric", month: "short", year: "numeric" })} at ${f({ hour: "2-digit", minute: "2-digit", hour12: false })}`;
}
/** The file name the export answer names (`attachment; filename="my-data-2026-11-25.json"`), or a fixed one. */
export const exportName = (disposition: string | null) => /filename="([A-Za-z0-9._-]{1,80})"/.exec(disposition ?? "")?.[1] ?? "my-data.json";
