import type { Metadata } from "next";
import { meta } from "../../../_site/meta";
import { needLogin, outLinks } from "../../../_site/guard";
import { SignOutButton } from "../../forms";
import { AuthFrame } from "../../frame";
import { ClaimForm } from "../../company-forms";

export const metadata: Metadata = meta("Find and claim your company", "Search the permit records for your company by name or CRO number and claim it. A company-domain email can go live at once, otherwise our team checks it.");

/** Step 3, frame E03: the signed-in login with no company searches and claims. `?q=` (a CRO number from the first-time step) fills the search box. */
export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const { q } = await searchParams;
  const login = await needLogin("/sign-up/claim");
  return (
    <AuthFrame step={3} title={<>Find and claim <span className="text-deep-green">your company</span></>} lead="Search the DETE permit records. If your company has sponsored a permit since 2019, it is in them."
      panel={["Already a sponsor?", "Fewer steps."]} panelLead="With an email on your company's own domain, an existing sponsor can post without waiting for staff. Otherwise we aim to review within 1 working day." {...outLinks()}>
      <ClaimForm email={login.email} initialQ={typeof q === "string" ? q.slice(0, 160) : ""} />
      <p className="text-small text-muted">Not {login.email}? <SignOutButton /></p>
    </AuthFrame>
  );
}
