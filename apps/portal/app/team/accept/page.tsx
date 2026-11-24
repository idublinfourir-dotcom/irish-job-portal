import type { Metadata } from "next";
import { Button, Notice } from "@portal/ui";
import { readLogin } from "../../../lib/data";
import { AcceptForm } from "../../(auth)/company-forms";
import { AuthFrame } from "../../(auth)/frame";
import { outLinks, signInThen } from "../../_site/guard";
import { tokenMeta } from "../../_site/meta";

export const metadata: Metadata = tokenMeta("Join a company team", "Accept the invitation to join a company team on Irish Work Permit for employers. Sign in or create a login with the email address the invitation was sent to.");

const TOKEN = /^[A-Za-z0-9_-]{43}$/; // the invite token is 32 random bytes in base64url

/** The emailed invitation link (`/team/accept?token=`). Signed out: sign in or create a login, then come back here. Signed in with no company: one button. Already in a company: say so. */
export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const { token } = await searchParams;
  const valid = typeof token === "string" && TOKEN.test(token);
  const here = valid ? `/team/accept?token=${token}` : "/team/accept";
  const login = await readLogin().catch(() => null);
  return (
    <AuthFrame title={<>Join a company <span className="text-deep-green">team</span></>} lead="A company invited you to post jobs with it on Irish Work Permit." panel={["You are", "invited"]} panelLead="Your role, and what it lets you do, were set by the account owner who invited you." {...outLinks()}>
      {!valid ? (
        <Notice kind="error" title="This invitation link is not complete">Open the link from the email again. If it still does not work, ask the account owner for a new invitation.</Notice>
      ) : login?.membership ? (
        <Notice kind="info" title="You already belong to a company">This login is in a company team, so it cannot take this invitation. Sign out and use the email address the invitation was sent to.</Notice>
      ) : login ? (
        <AcceptForm token={token} />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-muted">Use the email address the invitation was sent to.</p>
          <Button href={signInThen(here)} variant="dark" size="lg">Sign in to accept</Button>
          <Button href={`/sign-up/account?kind=employer&next=${encodeURIComponent(here)}`} variant="outline" size="lg">Create a login to accept</Button>
        </div>
      )}
    </AuthFrame>
  );
}
