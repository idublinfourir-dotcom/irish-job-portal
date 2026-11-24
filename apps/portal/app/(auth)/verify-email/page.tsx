import type { Metadata } from "next";
import { checkedNext } from "../../../lib/data";
import { Button, Notice } from "@portal/ui";
import { tokenMeta } from "../../_site/meta";
import { outLinks } from "../../_site/guard";
import { AuthFrame } from "../frame";
import { ResendForm } from "../forms";

export const metadata: Metadata = tokenMeta("Confirm your email", "Confirm the email address of your employer or agency login on Irish Work Permit, then sign in to find your company and start posting.");

/**
 * Where the emailed confirmation link ends (the callbackURL the sign-up and the resend give Better Auth). No error: the address is confirmed, go and sign in. `?error=` (Better Auth
 * sends INVALID_TOKEN when the link ended) or any other key: the link does not work, ask for a new one. It never redirects a signed-in visitor away.
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string | string[]; error?: string | string[] }> }) {
  const q = await searchParams;
  const next = checkedNext(q.next);
  const bad = q.error !== undefined;
  return (
    <AuthFrame title={bad ? <>This link <span className="text-deep-green">does not work</span></> : <>Email <span className="text-deep-green">confirmed</span></>}
      lead={bad ? "The link has ended or was already used. Enter your email and we send a new one." : "Your address is confirmed. Sign in to find your company and start posting."}
      panel={["One step", "left"]} panelLead="We confirm every email so that questions about your account reach the right person." {...outLinks()}>
      {bad ? <ResendForm next={next} /> : (
        <div className="flex flex-col gap-5">
          <Notice kind="success" title="Your email address is confirmed">Next you sign in, then search for your company.</Notice>
          <Button href={next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in"} variant="dark" size="lg" className="w-full">Sign in</Button>
        </div>
      )}
    </AuthFrame>
  );
}
