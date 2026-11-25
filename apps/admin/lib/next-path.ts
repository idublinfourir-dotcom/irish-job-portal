// A return address (`?next=`) on the staff sign-in is accepted only as a path on our own site (ownPath, packages/auth/src/reauth.ts: one leading slash, not followed by
// a slash or backslash, printable ASCII, no encoded slash before the query), and never a sign-in page or an API route. A relative path always resolves to the
// origin it is given, so a fixed one is enough here. An open redirect is a security finding. Checked on the server; the form only gets the checked path.
import { ownPath } from "@portal/auth";

const LOOP = /^\/(sign-in|forgot-password|reset-password|api)(\/|\?|#|$)/i;

export function checkedNext(raw: string | string[] | undefined): string | null {
  return typeof raw === "string" && ownPath(raw, "https://staff.invalid") && !LOOP.test(raw) ? raw : null;
}
