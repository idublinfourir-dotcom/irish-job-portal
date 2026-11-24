// /help: help and contact (P10, frame C21). Reads only through lib/data.ts: the help list (B19) and whether a candidate is signed in. The contact form posts to POST /api/contact.
import type { Metadata } from "next";
import { readHelpList, readSignedIn } from "../../lib/data";
import { staticPath } from "../../lib/paths";
import { meta } from "../_content/meta";
import { HelpView, type HelpItem } from "./help-view";

export const generateMetadata = (): Metadata => meta("Help and contact", "Answers about accounts, jobs and badges, permit services and reporting a problem, and a form to contact the Irish Work Permit team.", staticPath("help")!);

export default async function Page() {
  const [list, signedIn] = await Promise.all([readHelpList(), readSignedIn()]);
  return <HelpView pages={list.ok ? (list.data as { pages: HelpItem[] }).pages : null} signedIn={signedIn} />;
}
