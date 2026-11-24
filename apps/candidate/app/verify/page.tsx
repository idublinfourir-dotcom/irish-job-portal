// /verify (frame C27): where the emailed verification link lands. `?verified=1` is the verified page (a link used a second time lands there too: the
// library treats a confirmed address as done), `?error=<code>` is a link that did not work, and the bare address asks for the email to send a new link to.
import type { Metadata } from "next";
import { readSignedIn } from "../../lib/data";
import { CheckEmailFlow } from "../(auth)/forms";
import { authMeta, VERIFY_META } from "../(auth)/meta";
import { verifyError } from "../(auth)/messages";
import { checkedNext } from "../(auth)/next-path";
import { VerifiedView } from "../(auth)/views";
import { afterSignInPath, loginPath } from "../../lib/paths";

export const generateMetadata = (): Metadata => authMeta(...VERIFY_META);

type Q = { verified?: string | string[]; error?: string | string[]; next?: string | string[] };
export default async function Page({ searchParams }: { searchParams: Promise<Q> }) {
  const { verified, error, next } = await searchParams;
  const to = checkedNext(next);
  if (error !== undefined) return <CheckEmailFlow email={null} next={to} initialFlash={{ kind: "error", text: verifyError(typeof error === "string" ? error : undefined) }} />; // an error wins over "verified": the library adds it to the address
  if (verified === "1") return <VerifiedView signedIn={await readSignedIn()} loginHref={loginPath(to)} continueHref={to ?? afterSignInPath()} />;
  return <CheckEmailFlow email={null} next={to} />;
}
