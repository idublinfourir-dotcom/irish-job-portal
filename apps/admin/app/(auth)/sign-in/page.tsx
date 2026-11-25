import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SITE_NAME } from "@portal/ui";
import { readSidebar } from "../../../lib/data";
import { checkedNext } from "../../../lib/next-path";
import { AuthFrame } from "../auth-frame";
import { SignInForm } from "../auth-forms";

export const metadata: Metadata = { title: `Staff sign in, ${SITE_NAME} admin`, robots: { index: false, follow: false } };

/** The staff sign-in. A signed-in staff member goes to the overview. `?next=` (an own path, checked here) is where a sign-in again (DD10) comes back to. */
export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const next = checkedNext((await searchParams).next);
  if (await readSidebar()) redirect(next ?? "/");
  return (
    <AuthFrame title={<>Staff <span className="text-deep-green">sign in</span></>} lead="Sign in with your staff email and password.">
      <SignInForm next={next} />
    </AuthFrame>
  );
}
