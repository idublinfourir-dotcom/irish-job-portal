import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SITE_NAME } from "@portal/ui";
import { readSidebar } from "../../../lib/data";
import { AuthFrame } from "../auth-frame";
import { ResetForm, ResetView } from "../auth-forms";

export const metadata: Metadata = { title: `Choose a new password, ${SITE_NAME} admin`, robots: { index: false, follow: false }, referrer: "no-referrer" };

/** The emailed link ends here as /reset-password?token=... (or ?error=INVALID_TOKEN when Better Auth found the token ended or used). */
export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string | string[]; error?: string | string[] }> }) {
  if (await readSidebar()) redirect("/");
  const { token, error } = await searchParams;
  const usable = typeof token === "string" && token.length > 0 && token.length <= 200 && error === undefined;
  return (
    <AuthFrame title={<>Choose a new <span className="text-deep-green">password</span></>}>
      {usable ? <ResetForm token={token} /> : <ResetView invalid />}
    </AuthFrame>
  );
}
