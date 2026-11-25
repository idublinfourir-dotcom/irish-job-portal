// What /unsubscribe says when the API answers (GET and POST /api/alerts/unsubscribe, docs/openapi/candidate.yaml). Pure text, one sentence per code.
import type { Res } from "../(auth)/messages";

export const BAD_LINK = "This link does not work. Open the link in the email again, or sign in and change your alerts from your account.";
const BY_CODE: Record<string, string> = {
  BAD_REQUEST: BAD_LINK,
  TOO_MANY_REQUESTS: "Too many tries. Wait a minute, then try again.",
  BODY_TOO_LARGE: "The request was too large to send. Reload the page and try again.",
};
export function unsubscribeSay(r: Res): string {
  if (r.status === 0) return "We could not reach the site. Check your connection and try again.";
  if (r.status === 429) return BY_CODE.TOO_MANY_REQUESTS!;
  const by = BY_CODE[r.code ?? ""];
  if (by) return by;
  return r.status >= 500 ? "Something went wrong on our side. Try again in a few minutes." : "That did not work. Reload the page and try again.";
}
/** The two query keys, checked as the API checks them (the page reads nothing for a link that fails here). */
export const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;
export const parseLink = (token: unknown, scope: unknown): { token: string; scope: "one" | "all" } | null =>
  typeof token === "string" && TOKEN.test(token) && (scope === "one" || scope === "all") ? { token, scope } : null;
