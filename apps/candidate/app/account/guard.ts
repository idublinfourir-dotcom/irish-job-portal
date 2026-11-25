// The server-side guard of the account pages: each page hands it its own address, so a signed-out visitor goes to sign-in and comes back (`?next=`). The layout is not told the address.
import "server-only";
import { redirect } from "next/navigation";
import type { ReadResult } from "@portal/db";
import { loginPath } from "../../lib/paths";

/** The read, or a redirect to sign-in on 401. */
export function orSignIn(r: ReadResult, back: string): ReadResult {
  if (!r.ok && r.status === 401) redirect(loginPath(back));
  return r;
}

/** The data of a read, or a redirect to sign-in on 401. Any other refusal is returned so the page can say so. */
export function need(r: ReadResult, back: string): { data: unknown } | { refused: number; code: string } {
  orSignIn(r, back);
  if (r.ok) return { data: r.data };
  return { refused: r.status, code: r.code };
}
