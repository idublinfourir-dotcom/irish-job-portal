// What the permit case pages say when a route answers (codes from docs/openapi/candidate.yaml, paths /api/candidate/cases...). Upload answers use `say("upload")`
// from (auth)/messages.ts. Pure text; a test holds every code the contract names to its own sentence. The server's own message is never shown.
import type { Res } from "../../(auth)/messages";

export type CaseFlow = "withdraw" | "read";
const WAIT = "Too many tries. Wait a few minutes, then try again.";
const BY_CODE: Record<CaseFlow, Record<string, string>> = {
  withdraw: {
    CASE_NOT_OPEN: "This request has already been decided or closed, so it cannot be withdrawn.",
    CASE_NOT_FOUND: "We could not find that request.",
    NO_SESSION: "Your sign-in has ended. Log in again to withdraw the request.",
    BAD_ORIGIN: "The page could not confirm where the request came from. Reload the page and try again.",
    REFUSED: "This account cannot change permit requests. If you think this is a mistake, use the Help page to contact us.",
    BODY_TOO_LARGE: "The request was too large to send. Reload the page and try again.",
  },
  read: {
    BAD_REQUEST: "We could not read that address. Go back to your requests and open it again.",
    CASE_NOT_FOUND: "We could not find that request.",
    NO_SESSION: "Your sign-in has ended. Log in again to see your requests.",
    REFUSED: "This account cannot see permit requests. If you think this is a mistake, use the Help page to contact us.",
    FILES_UNAVAILABLE: "Documents are not open yet. Please try again later.",
    DOCUMENT_NOT_FOUND: "That copy is no longer kept, so it cannot be opened.",
    SCAN_PENDING: "This copy is still being checked for viruses. Try again in a minute.",
    FILE_BLOCKED: "This copy did not pass the virus check, so it cannot be opened. Upload a clean copy.",
  },
};
/** The message for one answer of one route; an unknown code gets the general line of its status, never a blank or the server's text. */
export function caseSay(flow: CaseFlow, r: Res): string {
  const { status, code } = r;
  if (status === 0) return "We could not reach the site. Check your connection and try again.";
  if (status === 429 || code === "TOO_MANY_REQUESTS") return WAIT;
  const by = BY_CODE[flow][code ?? ""];
  if (by) return by;
  if (status >= 500) return "Something went wrong on our side. Try again in a few minutes.";
  return "That did not work. Reload the page and try again.";
}
