// /report: the "Report it" link of the home page and the footer (decision #259: reporting a job needs a login). Reads only through lib/data.ts (whether a candidate is signed in).
// Signed out: "Sign in to report a job" and the contact form. Signed in: open the job and use its Report button, and the contact form. A report on a company is on the company page.
import type { Metadata } from "next";
import { readSignedIn } from "../../lib/data";
import { meta } from "../_content/meta";
import { ReportView } from "./report-view";

export const generateMetadata = (): Metadata => meta("Report a job or a company", "No genuine employer asks you to pay for a job offer. Sign in to report a job or a company, or send us a message if you cannot.", "/report");

export default async function Page() {
  return <ReportView signedIn={await readSignedIn()} />;
}
