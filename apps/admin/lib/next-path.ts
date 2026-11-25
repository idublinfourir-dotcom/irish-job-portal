// A return address (`?next=`) is accepted only as a path on our own site, and only here on the server: the sign-in page hands its form the checked path, and a client
// component never imports @portal/auth. An open redirect is a security finding, so everything unusual is refused (ownPath: one leading slash, not followed by a slash or
// backslash, printable ASCII, no backslash, no encoded slash before the query, at most 1,000 characters). A repeated `next` is ignored, and so is one that would send a
// signed-in person back to a sign-in page or into the API. Not in the page files: the import wall keeps @portal/auth out of app/.
import "server-only";
import { ownPath, staffSettings } from "@portal/auth";

const LOOP = /^\/(sign-in|forgot-password|reset-password|api)(\/|\?|#|$)/i;

export function checkedNext(raw: string | string[] | undefined): string | null {
  if (typeof raw !== "string") return null;
  let origin: string;
  try { origin = new URL(staffSettings(process.env).baseURL).origin; } catch { return null; }
  return ownPath(raw, origin) && !LOOP.test(raw) ? raw : null;
}
