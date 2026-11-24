// /permit-services (frame C19 in the Mint Pill style, DD26): what we do for a permit request, who pays, and how a case moves. Reads only through lib/data.ts:
// the DETE-closed notice (#291), whether a candidate is signed in, and their open requests.
import type { Metadata } from "next";
import { connection } from "next/server";
import { readCases, readPermitNotice, readSignedIn } from "../../lib/data";
import { safe } from "../_home/safe";
import { accountPath, casePath, loginPath, permitRequestPath, signupPath } from "../../lib/paths";
import { pageDescription, pageTitle } from "../../lib/seo";
import { LandingView, noticeOf } from "./landing";

const DESCRIPTION = "Our own team prepares your employment permit application and tracks the case with you and your employer. Candidates never pay for our services. The employer or agency does.";
export const generateMetadata = (): Metadata => ({ title: pageTitle("Permit services"), description: pageDescription(DESCRIPTION) });

type Case = { id: string; status: string };
export default async function Page() {
  await connection(); // built per visit: the page shows who is signed in and their open requests
  const [notice, signedIn] = await Promise.all([safe(readPermitNotice(), "permit notice"), readSignedIn()]); // a failed notice read hides the notice (logged), it does not take the page down
  const start = permitRequestPath();
  const cases = signedIn ? await safe(readCases(), "open requests") : null;
  const open = cases?.ok ? ((cases.data as { cases: Case[] }).cases ?? []).filter((c) => c.status !== "closed") : [];
  return (
    <LandingView
      variant={!signedIn ? "visitor" : open.length ? "open-case" : "no-case"}
      open={open.length ? { count: open.length, href: open.length === 1 ? casePath(open[0]!.id) : accountPath() } : undefined}
      notice={notice.ok ? noticeOf(notice.data) : null}
      startHref={signedIn ? start : loginPath(start)}
      loginHref={loginPath(start)}
      signupHref={signupPath(start)}
      trackHref={loginPath(accountPath())}
    />
  );
}
