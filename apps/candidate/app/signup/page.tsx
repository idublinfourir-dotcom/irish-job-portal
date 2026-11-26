// /signup (frames NS3, M06 and C24): the account form with the permit question first. A signed-in candidate goes on to `next` (a checked own path) or the account.
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { readSignedIn, readSignInProviders } from "../../lib/data";
import { employersHref } from "../_home/meta";
import { SignupFlow } from "../(auth)/forms";
import { authMeta, SIGNUP_META } from "../(auth)/meta";
import { checkedNext } from "../(auth)/next-path";
import { afterSignInPath } from "../../lib/paths";
import { siteRobots } from "../../lib/seo";

// IDX1 (#304): the one sign-in page search engines may list at launch; it follows the site's switch (SITE_INDEXABLE), the other four stay noindex.
export const generateMetadata = (): Metadata => authMeta(...SIGNUP_META, { robots: siteRobots() });

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const next = checkedNext((await searchParams).next);
  if (await readSignedIn()) redirect(next ?? afterSignInPath());
  return <SignupFlow google={readSignInProviders().google} employersHref={employersHref()} next={next} />;
}
