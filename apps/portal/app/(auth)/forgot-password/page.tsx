import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { homeFor, readLogin } from "../../../lib/data";
import { meta } from "../../_site/meta";
import { outLinks } from "../../_site/guard";
import { AuthFrame } from "../frame";
import { ForgotForm } from "../forms";

export const metadata: Metadata = meta("Reset your password", "Enter your work email and we send a link to choose a new password for your employer or agency login on Irish Work Permit.");

export default async function Page() {
  const login = await readLogin().catch(() => null);
  if (login) redirect(homeFor(login));
  return (
    <AuthFrame title={<>Reset your <span className="text-deep-green">password</span></>} lead="Enter your work email. If it has a login, we send a link to choose a new password." panel={["Back in", "a minute"]} panelLead="The link works for 1 hour and only once. Your other sign-ins end when you change the password." {...outLinks()}>
      <ForgotForm />
    </AuthFrame>
  );
}
