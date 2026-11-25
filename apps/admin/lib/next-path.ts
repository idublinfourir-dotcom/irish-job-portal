// A return address (`?next=`) is accepted only as a path on our own site (ownPath: one leading slash, not followed by a slash or backslash, printable ASCII, no
// backslash, no encoded slash before the query, at most 1,000 characters), and only here on the server: the sign-in page hands its form the checked path. A repeated
// `next` is ignored, and so is one that would send a signed-in person back to a sign-in page or into the API.
import { ownPath, staffSettings } from "@portal/auth";

const LOOP = /^\/(sign-in|forgot-password|reset-password|api)(\/|\?|#|$)/i;

export function checkedNext(raw: string | string[] | undefined): string | null {
  if (typeof raw !== "string") return null;
  try {
    return ownPath(raw, new URL(staffSettings(process.env).baseURL).origin) && !LOOP.test(raw) ? raw : null;
  } catch {
    return null;
  }
}
