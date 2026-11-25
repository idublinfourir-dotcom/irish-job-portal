// The server-side guard of the account pages until the shared layout lands: a signed-out visitor goes to sign-in and back (`?next=`), a refused account sees why.
import "server-only";
import { redirect } from "next/navigation";
import type { ReadResult } from "@portal/db";
import { loginPath } from "../../lib/paths";

/** The data of a read, or a redirect to sign-in on 401. Any other refusal is returned so the page can say so. */
export function need(r: ReadResult, back: string): { data: unknown } | { refused: number; code: string } {
  if (r.ok) return { data: r.data };
  if (r.status === 401) redirect(loginPath(back));
  return { refused: r.status, code: r.code };
}
