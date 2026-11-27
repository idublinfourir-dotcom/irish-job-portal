// /confirm-email?token=&callbackURL= (SEC-3): where the emailed verify, change-email and new-email links land. Opening it changes nothing and makes no
// call (a mail filter that opens every link does no harm). The button is a GET form to Better Auth's /verify-email with the same token, which then
// redirects to callbackURL (our /verify-email or /settings page, with ?error= when the link ended, was used or was forged). noindex, no referrer.
import type { Metadata } from "next";
import { Button } from "@portal/ui";
import { checkedNext } from "../../../lib/data";
import { tokenMeta } from "../../_site/meta";
import { outLinks } from "../../_site/guard";
import { AuthFrame } from "../frame";

export const metadata: Metadata = tokenMeta("Confirm your email", "Confirm the email address of your employer or agency login on Irish Work Permit with one press of the button. Opening the link alone changes nothing.");

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
// A signed token (three base64url parts); Better Auth checks its signature and expiry when the button is pressed.
const TOKEN = /^[\w-]{1,2000}\.[\w-]{1,2000}\.[\w-]{1,2000}$/;
const PANEL = { panel: ["One step", "left"] as [string, string], panelLead: "We confirm every email so that questions about your account reach the right person." };

export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string | string[]; callbackURL?: string | string[] }> }) {
  const q = await searchParams;
  const token = one(q.token), cb = one(q.callbackURL);
  if (!token || !TOKEN.test(token))
    return (
      <AuthFrame title={<>This link <span className="text-deep-green">does not work</span></>} lead="The link is not complete. Ask for a new one and use the button in that email." {...PANEL} {...outLinks()}>
        <Button href="/verify-email?error=INVALID_TOKEN" variant="dark" size="lg" className="w-full">Ask for a new link</Button>
      </AuthFrame>
    );
  return (
    <AuthFrame title={<>Confirm your <span className="text-deep-green">email</span></>} lead="Press the button to confirm. Nothing changes on your login until you do." {...PANEL} {...outLinks()}>
      <form method="get" action="/api/auth/portal/verify-email" rel="noreferrer">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="callbackURL" value={checkedNext(cb) ?? "/verify-email"} />
        <Button type="submit" variant="dark" size="lg" className="w-full">Confirm</Button>
      </form>
    </AuthFrame>
  );
}
