import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SITE_NAME } from "@portal/ui";
import { readSidebar } from "../../../lib/data";
import { AuthFrame } from "../auth-frame";
import { SignInForm } from "../auth-forms";

export const metadata: Metadata = { title: `Staff sign in, ${SITE_NAME} admin`, robots: { index: false, follow: false } };

/** The staff sign-in. A signed-in staff member goes to the overview. */
export default async function Page() {
  if (await readSidebar()) redirect("/");
  return (
    <AuthFrame title={<>Staff <span className="text-deep-green">sign in</span></>} lead="Sign in with your staff email and password.">
      <SignInForm />
    </AuthFrame>
  );
}
