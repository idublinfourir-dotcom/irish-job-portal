import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SITE_NAME } from "@portal/ui";
import { checkedNext } from "../../../lib/next-path";
import { readSidebar } from "../../../lib/data";
import { one } from "../../_queue/guard";
import { AuthFrame } from "../auth-frame";
import { SignInForm } from "../auth-forms";

export const metadata: Metadata = { title: `Staff sign in, ${SITE_NAME} admin`, robots: { index: false, follow: false } };

/**
 * The staff sign-in. A signed-in staff member goes to the overview, or to the page in `?next=` (an own path only). `?again=1` shows the form to a signed-in
 * member too: that is the re-sign-in a sensitive action asks for (C4, DD10), which ends back on the page it came from with nothing lost but the form.
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string | string[]; again?: string | string[] }> }) {
  const q = await searchParams;
  const next = checkedNext(q.next);
  const again = one(q.again) === "1";
  if (!again && (await readSidebar())) redirect(next ?? "/");
  return (
    <AuthFrame title={<>Staff <span className="text-deep-green">sign in</span></>} lead={again ? "This action needs a sign-in from the last 10 minutes. Sign in again to carry on." : "Sign in with your staff email and password."}>
      <SignInForm next={next ?? undefined} />
    </AuthFrame>
  );
}
