import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Notice } from "@portal/ui";
import { candidateHref, PORTAL_SIGN_IN, readLogin, readVerification } from "../../lib/data";
import { meta } from "../_site/meta";
import { VerificationView, type Verification } from "./view";

export const metadata: Metadata = meta("Verification", "See how far the verification of your company has got, what we have checked so far and, when we ask for more, what to send us.");

/** The "Draft a job" link opens /jobs/new, which P19 builds: set true there. */
const JOB_FORM_LIVE = false as boolean;

/** Frame E06. Signed out goes to sign-in; no company goes to the claim step; any member sees the state, only the owner sees the question and the answer box. */
export default async function Page() {
  const [login, read] = await Promise.all([readLogin().catch(() => null), readVerification().catch(() => null)]);
  if (!login || read?.status === 401) redirect(`${PORTAL_SIGN_IN}?next=${encodeURIComponent("/verification")}`);
  if (!login.membership || read?.status === 404) redirect("/sign-up/claim");
  const v = read?.status === 200 ? (read.body.verification as Verification | undefined) : undefined;
  if (!v) return <div className="py-8"><Notice kind="error" title="We cannot show this page now">{read?.status === 403 ? "This login cannot open it. Contact support." : "Try again in a few minutes."}</Notice></div>;
  const role = login.membership.role;
  return <VerificationView email={login.email} v={v} isOwner={role === "account_owner"} canDraft={JOB_FORM_LIVE && role !== "viewer"} help={candidateHref("/help")} />;
}
