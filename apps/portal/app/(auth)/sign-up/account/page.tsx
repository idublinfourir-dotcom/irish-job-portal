import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { A } from "@portal/ui";
import { checkedNext, homeFor, readLogin } from "../../../../lib/data";
import { meta } from "../../../_site/meta";
import { outLinks } from "../../../_site/guard";
import { AuthFrame } from "../../frame";
import { SignUpForm } from "../../forms";

export const metadata: Metadata = meta("Create your employer login", "Enter your name, work email and a password to start. We send a link to confirm the address, then you find your company and send it for verification.");

/** Step 2: the account (decision #287: account first, then the company). The type comes from step 1 as ?kind=; `?next=` is kept only as a path of our own (the invitation uses it). */
export default async function Page({ searchParams }: { searchParams: Promise<{ kind?: string | string[]; next?: string | string[] }> }) {
  const q = await searchParams;
  const kind = q.kind === "agency" ? "agency" : "employer";
  const login = await readLogin().catch(() => null);
  if (login) redirect(homeFor(login));
  return (
    <AuthFrame step={2} title={<>Create your <span className="text-deep-green">login</span></>} lead={kind === "agency" ? "Your login comes first. Next you give your agency licence." : "Your login comes first. Next you find your company."} panel={["Post jobs", "candidates can trust"]} panelLead="Every employer and agency is verified before a job goes live." {...outLinks()}>
      <SignUpForm kind={kind} next={checkedNext(q.next)} termsHref="/terms" />
      <p className="text-small text-muted">Already have a login? <A href="/sign-in" className="font-semibold text-deep-green underline underline-offset-2">Sign in</A></p>
    </AuthFrame>
  );
}
