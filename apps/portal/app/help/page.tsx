import type { Metadata } from "next";
import { candidateHref, PORTAL_SIGN_IN, readLogin } from "../../lib/data";
import { meta } from "../_site/meta";
import { Page as SiteFrame } from "../_site/chrome";
import { topicsFor } from "./topics";
import { HelpView } from "./view";

export const metadata: Metadata = meta("Help", "Find the page that answers your question about verification, your team, your account or a strike, or write to our team. A blocked login can appeal here.");

/**
 * BA22. Open to everyone: a suspended, closed or restricted company, and a blocked login (a visitor to the site), must still reach it. A signed-in login picks a topic; a visitor can send an appeal only.
 * `?topic=` preselects a topic and is ignored unless it is one this sender may use.
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ topic?: string | string[] }> }) {
  const { topic } = await searchParams;
  const login = await readLogin().catch(() => null);
  const member = !!login?.membership;
  const t = typeof topic === "string" && topicsFor(!!login).includes(topic) ? topic : "";
  const view = <HelpView signedIn={!!login} member={member} topic={t} candidateHelp={candidateHref("/help")} signIn={PORTAL_SIGN_IN} />;
  return member ? view : <SiteFrame candidates={candidateHref("/")}><div className="mt-6">{view}</div></SiteFrame>;
}
