"use client";
// DD10, CF129: shown when a route answered reauth_required. The button ends the session and opens the staff sign-in page, which brings the person back to `back`
// (a path the server page chose, never typed by a visitor). Nothing but the form is lost.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Notice } from "@portal/ui";

export function ReauthNotice({ back }: { back: string }) {
  const router = useRouter(), [failed, setFailed] = useState(false);
  async function again() {
    const ok = await fetch("/api/auth/staff/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", credentials: "same-origin" }).then((r) => r.ok, () => false);
    if (ok) { router.replace(`/sign-in?next=${encodeURIComponent(back)}`); router.refresh(); } // refresh: the layout reads that the session has ended
    else setFailed(true);
  }
  return (
    <Notice kind="info" title="Sign in again">
      <p className="mb-3">This needs a sign-in in the last 10 minutes. You will come back to this page.</p>
      <Button type="button" variant="dark" onClick={() => void again()}>Sign in again</Button>
      {failed && <p className="mt-2 text-small">Sign out did not work. Try again.</p>}
    </Notice>
  );
}
