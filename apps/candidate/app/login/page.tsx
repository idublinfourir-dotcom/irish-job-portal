// /login (frame C26): sign in with email and password (Google when the site has it). `next` is the page to return to, accepted only as an own path.
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { readSignedIn, readSignInProviders } from "../../lib/data";
import { LoginFlow } from "../(auth)/forms";
import { authMeta, LOGIN_META } from "../(auth)/meta";
import { checkedNext } from "../(auth)/next-path";
import { afterSignInPath } from "../../lib/paths";

export const generateMetadata = (): Metadata => authMeta(...LOGIN_META);

// What the page says when Google's own sign-in comes back here with `?error=`: one fixed line, never the code.
const GOOGLE_LINE = "Google sign-in did not finish. Try again, or use your email and password.";
// A Google address with no account comes back with SIGNUP_ANSWERS_REFUSED (packages/auth/src/signup.ts): only sign-up asks the questions an account needs.
const NO_ACCOUNT_LINE = "This Google address has no account yet. Create a free account first with the link below, then continue with Google there.";

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string | string[]; error?: string | string[] }> }) {
  const { next, error } = await searchParams;
  const to = checkedNext(next);
  if (await readSignedIn()) redirect(to ?? afterSignInPath());
  return <LoginFlow google={readSignInProviders().google} next={to} notice={error === undefined ? undefined : [error].flat().includes("SIGNUP_ANSWERS_REFUSED") ? NO_ACCOUNT_LINE : GOOGLE_LINE} />;
}
