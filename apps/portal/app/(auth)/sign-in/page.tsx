import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { checkedNext, homeFor, readLogin } from "../../../lib/data";
import { meta } from "../../_site/meta";
import { outLinks } from "../../_site/guard";
import { AuthFrame } from "../frame";
import { SignInForm } from "../forms";

export const metadata: Metadata = meta("Employer sign in", "Sign in to post sponsored jobs, check your company's verification and manage your team on Irish Work Permit for employers and recruitment agencies.");

/** The employer sign-in. A signed-in login goes where it belongs; `?next=` is kept only as a path of our own. `?reset=1` is the end of a password reset. */
export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string | string[]; reset?: string | string[] }> }) {
  const q = await searchParams;
  const next = checkedNext(q.next);
  const login = await readLogin().catch(() => null);
  if (login) redirect(next ?? homeFor(login));
  return (
    <AuthFrame title={<>Employer <span className="text-deep-green">sign in</span></>} lead="Sign in with the email and password you made your account with." panel={["Post jobs", "candidates can trust"]} panelLead="Every employer and agency is verified before a job goes live." {...outLinks()}>
      <SignInForm next={next} notice={q.reset === "1" ? "Your password was changed. Sign in with the new one." : undefined} />
    </AuthFrame>
  );
}
