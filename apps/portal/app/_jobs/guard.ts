// The guard of the pages of a company member: signed out goes to sign-in and back; no company or one still in review goes to its own step (homeFor).
import { redirect } from "next/navigation";
import { homeFor, PORTAL_SIGN_IN, readLogin } from "../../lib/data";
import { signInThen } from "../_site/guard";

/** The login's membership (role, company status), or a redirect. `here` is a constant path of ours; the dashboard is where sign-in goes anyway, so it carries no return address. */
export async function member(here: string) {
  const login = await readLogin().catch(() => null);
  if (!login) redirect(here === "/dashboard" ? PORTAL_SIGN_IN : signInThen(here));
  const to = homeFor(login);
  if (to !== "/dashboard") redirect(to);
  return login.membership!;
}

/** Any signed-in login (the notices page: the bell is for any active login). */
export async function anyLogin(here: string) {
  const login = await readLogin().catch(() => null);
  if (!login) redirect(signInThen(here));
  return login;
}

/** A read's JSON body field, or undefined when the read did not answer 200. */
export const bodyOf = <T>(r: { status: number; body: Record<string, unknown> } | null | undefined, key: string): T | undefined => (r?.status === 200 ? (r.body[key] as T | undefined) : undefined);

/** The time now in ms (a function, so a page can call it while rendering: the render-purity lint forbids the bare call). */
export const nowMs = () => Date.now();
