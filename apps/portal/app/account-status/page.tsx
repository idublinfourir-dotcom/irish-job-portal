import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { A, Notice } from "@portal/ui";
import { PORTAL_SIGN_IN, readLogin, readStatus } from "../../lib/data";
import { meta } from "../_site/meta";
import { StatusView, type StatusPage } from "./view";

export const metadata: Metadata = meta("Account status", "See your company's strikes, warnings and cases, reply to a case, and appeal a decision. Any member can read it, and the account owner replies and appeals.");

/** Frame E20 (DD18). Signed out goes to sign-in. A suspended, restricted or banned company still opens it; a login with no company (a closed one) is told so and pointed to help. */
export default async function Page() {
  const [login, read] = await Promise.all([readLogin().catch(() => null), readStatus().catch(() => null)]);
  if (!login || read?.status === 401) redirect(`${PORTAL_SIGN_IN}?next=${encodeURIComponent("/account-status")}`);
  if (!login.membership || read?.status === 404) return <div className="py-8"><Notice kind="info" title="This login is not in a company">There is no company account to show. <A href="/sign-up/claim" className="font-semibold underline underline-offset-2">Claim or register a company</A>, or <A href="/help" className="font-semibold underline underline-offset-2">contact us</A>.</Notice></div>;
  const page = read?.status === 200 ? (read.body.page as StatusPage | undefined) : undefined;
  if (!page) return <div className="py-8"><Notice kind="error" title="We cannot show this page now">{read?.status === 403 ? "This login cannot open it. Use the contact form on the Help page." : "Try again in a few minutes."}</Notice></div>;
  return <StatusView p={page} />;
}
