import type { Metadata } from "next";
import { meta } from "../_site/meta";
import { LegalPage } from "../_legal/legal-page";

export const metadata: Metadata = meta("Privacy notice", "How Irish Work Permit uses the personal data of employers, recruitment agencies and their team members, in the version that is in force today.");

export default function Page() {
  return <LegalPage purpose="privacy_notice" title="Privacy notice" />;
}
