import type { Metadata } from "next";
import { tokenMeta } from "../../_site/meta";
import { outLinks } from "../../_site/guard";
import { AuthFrame } from "../frame";
import { ResetForm, ResetView } from "../forms";

export const metadata: Metadata = tokenMeta("Choose a new password", "Choose a new password for your employer or agency login on Irish Work Permit. The link in your email works for 1 hour and only once.");

/** The emailed link ends here as /reset-password?token=... (or ?error=INVALID_TOKEN when Better Auth found the token ended or used). A signed-in person who opens it still gets the form: the token is kept. */
export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string | string[]; error?: string | string[] }> }) {
  const { token, error } = await searchParams;
  const usable = typeof token === "string" && token.length > 0 && token.length <= 200 && error === undefined;
  return (
    <AuthFrame title={<>Choose a new <span className="text-deep-green">password</span></>} panel={["Back in", "a minute"]} panelLead="Saving the new password ends every other sign-in of this login." {...outLinks()}>
      {usable ? <ResetForm token={token} /> : <ResetView invalid />}
    </AuthFrame>
  );
}
