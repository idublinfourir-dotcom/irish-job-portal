import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SITE_NAME } from "@portal/ui";
import { readSidebar } from "../../../lib/data";
import { AuthFrame } from "../auth-frame";
import { ForgotForm } from "../auth-forms";

export const metadata: Metadata = { title: `Reset your password, ${SITE_NAME} admin`, robots: { index: false, follow: false } };

export default async function Page() {
  if (await readSidebar()) redirect("/");
  return (
    <AuthFrame title={<>Reset your <span className="text-deep-green">password</span></>} lead="Enter your staff email. If it has a login, we send a link to choose a new password.">
      <ForgotForm />
    </AuthFrame>
  );
}
