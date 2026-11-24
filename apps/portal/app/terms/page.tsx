import type { Metadata } from "next";
import { meta } from "../_site/meta";
import { LegalPage } from "../_legal/legal-page";

export const metadata: Metadata = meta("Terms for employers and agencies", "The terms an employer or recruitment agency accepts when it creates a login on Irish Work Permit, in the version that is in force today.");

export default function Page() {
  return <LegalPage purpose="portal_signup_terms" title="Terms for employers and agencies" />;
}
