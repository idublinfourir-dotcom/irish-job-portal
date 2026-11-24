import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { candidateHref, homeFor, readLogin } from "../lib/data";
import { Landing } from "./_landing/landing";
import { meta } from "./_site/meta";

export const metadata: Metadata = meta("Hire people who need an Irish work permit", "Post sponsored jobs for free. Confirm sponsorship once, reach candidates who qualify, and let our team handle the permit after a hire. For employers.");

/** Frame NE1: the employer landing. A signed-in login goes where sign-in would send it (claim step, verification page, dashboard). */
export default async function Page() {
  const login = await readLogin().catch(() => null);
  if (login) redirect(homeFor(login));
  return <Landing candidates={candidateHref("/")} rules={candidateHref("/employer-acceptable-use")} help={candidateHref("/help")} />;
}
