// /reset (frame C27, "same layout"): no token asks for the email, `?token=` (the emailed link) chooses a new password, `?error=` is a link that did not work.
// A signed-in person who opens the emailed link still gets the form (the token is kept); the bare address sends them to their account. The address holds a
// token, so it is noindex and sends no referrer.
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { readSignedIn } from "../../lib/data";
import { ForgotFlow, ResetFlow } from "../(auth)/forms";
import { authMeta, RESET_META } from "../(auth)/meta";
import { resetLinkError } from "../(auth)/messages";
import { ResetView } from "../(auth)/views";
import { afterSignInPath } from "../../lib/paths";

export const generateMetadata = (): Metadata => authMeta(...RESET_META, { referrer: "no-referrer" });

export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string | string[]; error?: string | string[] }> }) {
  const { token, error } = await searchParams;
  if (token === undefined && error === undefined) {
    if (await readSignedIn()) redirect(afterSignInPath());
    return <ForgotFlow />;
  }
  const usable = typeof token === "string" && token.length > 0 && token.length <= 200 && error === undefined;
  return usable ? <ResetFlow token={token} /> : <ResetView invalid linkProblem={resetLinkError(typeof error === "string" ? error : undefined)} />;
}
