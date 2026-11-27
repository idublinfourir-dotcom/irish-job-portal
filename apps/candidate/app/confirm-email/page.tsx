// /confirm-email?token=&callbackURL= (SEC-3): where the emailed verify, change-email and new-email links land. Opening it changes nothing and makes no
// call (a mail filter that opens every link does no harm). The button is a GET form to Better Auth's /verify-email with the same token, which then
// redirects to callbackURL (our /verify or settings page, with ?error= when the link ended, was used or was forged). noindex, no referrer.
import type { Metadata } from "next";
import { Button } from "@portal/ui";
import { ownPath } from "@portal/auth";
import { AuthFrame } from "../(auth)/auth-frame";
import { authMeta } from "../(auth)/meta";
import { CHECK_SIDE } from "../(auth)/views";

export const generateMetadata = (): Metadata => authMeta("Confirm your email", "Confirm the email address of your Irish Work Permit account with one press of the button. Opening the link alone changes nothing on your account.", { referrer: "no-referrer" });

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
// A signed token (three base64url parts); Better Auth checks its signature and expiry when the button is pressed. Any own path is a relative path, so the
// origin given to ownPath is only a base for the check.
const TOKEN = /^[\w-]{1,2000}\.[\w-]{1,2000}\.[\w-]{1,2000}$/;

export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string | string[]; callbackURL?: string | string[] }> }) {
  const q = await searchParams;
  const token = one(q.token), cb = one(q.callbackURL);
  if (!token || !TOKEN.test(token))
    return (
      <AuthFrame title={<>This link <span className="text-deep-green">does not work</span></>} lead="The link is not complete. Ask for a new one and use the button in that email." side={CHECK_SIDE}>
        <Button href="/verify" variant="dark" size="lg" className="w-full">Ask for a new link</Button>
      </AuthFrame>
    );
  return (
    <AuthFrame title={<>Confirm your <span className="text-deep-green">email</span></>} lead="Press the button to confirm. Nothing changes on your account until you do." side={CHECK_SIDE}>
      <form method="get" action="/api/auth/candidate/verify-email" rel="noreferrer">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="callbackURL" value={ownPath(cb, "http://own.invalid") ? cb : "/verify"} />
        <Button type="submit" variant="dark" size="lg" className="w-full">Confirm</Button>
      </form>
    </AuthFrame>
  );
}
