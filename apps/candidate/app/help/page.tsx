// /help: help and contact (P10, frame C21). Reads only through lib/data.ts: the help list (B19) and whether a candidate is signed in. The contact form posts to POST /api/contact.
import type { Metadata } from "next";
import { cachedHelpList } from "../../lib/cached";
import { staticPath } from "../../lib/paths";
import { meta } from "../_content/meta";
import { HelpView, type HelpItem } from "./help-view";

export const generateMetadata = (): Metadata => meta("Help and contact", "Answers about accounts, jobs and badges, permit services and reporting a problem, and a form to contact the Irish Work Permit team.", staticPath("help")!);

// Stage 3 step 5: cached at the CDN for an hour; a content publish or withdraw clears it (CONTENT_PATHS). The contact form asks for a name and an
// email unless the hint cookie says signed in (contact-form.tsx); the route decides from the real session. A failed read throws.
export const revalidate = 3600;

export default async function Page() {
  const list = (await cachedHelpList()) as { pages: HelpItem[] };
  return <HelpView pages={list.pages} signedIn={undefined} />;
}
