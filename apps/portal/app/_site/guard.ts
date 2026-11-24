// The guard of the pages that need a login but not a company (the sign-up steps, the invitation): through lib/data.ts only.
import { redirect } from "next/navigation";
import { candidateHref, homeFor, PORTAL_SIGN_IN, readLogin } from "../../lib/data";

/** The sign-in address that comes back to `here` (a path of ours, never user input). */
export const signInThen = (here: string) => `${PORTAL_SIGN_IN}?next=${encodeURIComponent(here)}`;

/**
 * A signed-out visitor goes to sign-in and comes back to `here`. A login that already has a company goes where it belongs (verification page, dashboard), unless
 * `allowCompany` (the invitation page says so itself). Returns the login.
 */
export async function needLogin(here: string, allowCompany = false) {
  const login = await readLogin().catch(() => null);
  if (!login) redirect(signInThen(here));
  if (login.membership && !allowCompany) redirect(homeFor(login));
  return login;
}

/** The candidate site's links the frame shows (For candidates, Help); null when its address is not set. */
export const outLinks = () => ({ candidates: candidateHref("/"), help: candidateHref("/help") });
