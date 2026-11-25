import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Notice } from "@portal/ui";
import { candidateHref, PORTAL_SIGN_IN, readCompany, readLogin, readTeam } from "../../lib/data";
import { meta } from "../_site/meta";
import { CompanyView, type Company } from "./view";

export const metadata: Metadata = meta("Company profile", "Change what candidates see on your company page: the logo, website, county and a short description. See the facts we hold from the official records.");

const count = (v: unknown) => (Array.isArray(v) ? v.length : null);

/** Frame E18 and BA31. Signed out goes to sign-in, no company to the claim step. Any member sees the profile; only the account owner gets the buttons (the routes refuse the rest). */
export default async function Page() {
  const [login, read] = await Promise.all([readLogin().catch(() => null), readCompany().catch(() => null)]);
  if (!login || read?.status === 401) redirect(`${PORTAL_SIGN_IN}?next=${encodeURIComponent("/company")}`);
  if (!login.membership || read?.status === 404) redirect("/sign-up/claim");
  const c = read?.status === 200 ? (read.body.company as (Company & { logoUrl: string | null }) | undefined) : undefined;
  if (!c) return <div className="py-8"><Notice kind="error" title="We cannot show this page now">{read?.status === 403 ? "This login cannot open it. Use the contact form on the Help page." : "Try again in a few minutes."}</Notice></div>;
  const isOwner = login.membership.role === "account_owner";
  const team = isOwner ? ((await readTeam().catch(() => null))?.body.team as { members?: unknown; invites?: unknown } | null | undefined) : null;
  const logoSrc = c.logoUrl ? new URL(c.logoUrl, "http://x").pathname : null; // the portal's own address, whatever host it was made with
  return <CompanyView c={c} isOwner={isOwner} logoSrc={logoSrc} publicHref={candidateHref(`/companies/${encodeURIComponent(c.slug)}`)} members={count(team?.members)} invites={count(team?.invites)} />;
}
