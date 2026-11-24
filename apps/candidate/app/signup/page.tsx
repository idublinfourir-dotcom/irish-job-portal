// /signup (frames NS3, M06 and C24): the account form with the permit question first. A signed-in candidate goes on to `next` (a checked own path) or the account.
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { readSignedIn, readSignInProviders } from "../../lib/data";
import { employersHref } from "../_home/meta";
import { SignupFlow } from "../(auth)/forms";
import { authMeta, SIGNUP_META } from "../(auth)/meta";
import { checkedNext } from "../(auth)/next-path";
import { afterSignInPath } from "../../lib/paths";

export const generateMetadata = (): Metadata => authMeta(...SIGNUP_META);

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const next = checkedNext((await searchParams).next);
  if (await readSignedIn()) redirect(next ?? afterSignInPath());
  return <SignupFlow google={readSignInProviders().google} employersHref={employersHref()} next={next} />;
}
