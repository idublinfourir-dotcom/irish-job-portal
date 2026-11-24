import type { Metadata } from "next";
import { meta } from "../../../_site/meta";
import { needLogin, outLinks } from "../../../_site/guard";
import { SignOutButton } from "../../forms";
import { AuthFrame } from "../../frame";
import { AgencyForm } from "../../company-forms";

export const metadata: Metadata = meta("Recruitment agency", "Give your Employment Agency licence number and agency name. Our team checks the licence and reviews the account by hand before you post.");

/** Step 3, frame E05: a recruitment agency registers with its Employment Agency licence. */
export default async function Page() {
  const login = await needLogin("/sign-up/agency");
  return (
    <AuthFrame step={3} title={<>Recruitment <span className="text-deep-green">agency</span></>} lead="Agencies need an Employment Agency licence. We check yours."
      panel={["Licensed agencies", "only"]} panelLead="We check every licence. A licence that lapses stops new postings, and the jobs already live go to staff review." {...outLinks()}>
      <AgencyForm />
      <p className="text-small text-muted">Not {login.email}? <SignOutButton /></p>
    </AuthFrame>
  );
}
