// A return address (`?next=`) is accepted only as a path on our own site, and only here on the server: the pages hand the forms the checked path, and a
// client component never imports @portal/auth. An open redirect is a security finding, so everything unusual is refused (ownPath: one leading slash, not
// followed by a slash or backslash, printable ASCII, no backslash, no encoded slash before the query, at most 1,000 characters). A repeated `next` is
// ignored, and so is one that would send a signed-in person back to a sign-in page or into the API.
import "server-only";
import { ownPath } from "@portal/auth";
import { siteOrigin } from "../../lib/data";

const LOOP = /^\/(login|signup|verify|reset|api)(\/|\?|#|$)/i;

export function checkedNext(raw: string | string[] | undefined): string | null {
  if (typeof raw !== "string") return null;
  let origin: string;
  try { origin = siteOrigin(); } catch { return null; }
  return ownPath(raw, origin) && !LOOP.test(raw) ? raw : null;
}
