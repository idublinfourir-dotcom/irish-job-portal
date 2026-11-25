"use client";
// DD10, CF129: shown when a route answered reauth_required. The one staff re-sign-in: the sign-in page with `?again=1`, which comes back to `back` (a path of ours).
import { Button, Notice } from "@portal/ui";
import { signInAgain } from "../_queue/act";

export const ReauthNotice = ({ back }: { back: string }) => (
  <Notice kind="info" title="Sign in again">
    <p className="mb-3">This needs a sign-in in the last 10 minutes. You will come back to this page.</p>
    <Button href={signInAgain(back)} variant="dark">Sign in again</Button>
  </Notice>
);
