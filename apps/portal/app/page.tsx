import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { candidateHref, homeFor, readLogin } from "../lib/data";
import { Landing } from "./_landing/landing";
import { meta } from "./_site/meta";

// IDX1 (#304): the employer landing is the one portal page search engines may list, once SITE_INDEXABLE=1 on this project; the layout keeps every other page noindex.
export const generateMetadata = (): Metadata => meta("Hire people who need an Irish work permit", "Post sponsored jobs for free. Confirm sponsorship once, reach candidates who qualify, and let our team handle the permit after a hire. For employers.", {
  robots: process.env.SITE_INDEXABLE === "1" ? { index: true, follow: true } : { index: false, follow: false },
});

/** Frame NE1: the employer landing. A signed-in login goes where sign-in would send it (claim step, verification page, dashboard). */
export default async function Page() {
  const login = await readLogin().catch(() => null);
  if (login) redirect(homeFor(login));
  return <Landing candidates={candidateHref("/")} rules={candidateHref("/employer-acceptable-use")} help={candidateHref("/help")} />;
}
