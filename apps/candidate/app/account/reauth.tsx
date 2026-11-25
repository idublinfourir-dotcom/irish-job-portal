"use client";
import { Button, Notice } from "@portal/ui";
import { signInAgain } from "./client";

/** DD10: shown when a route answered REAUTH_REQUIRED. The button signs out and opens the sign-in page, which brings the person back to `back`. */
export function ReauthNotice({ text, back }: { text: string; back: string }) {
  return (
    <Notice kind="info" title="Sign in again">
      <p className="mb-3">{text}</p>
      <Button type="button" variant="dark" onClick={() => void signInAgain(back)}>Sign in again</Button>
    </Notice>
  );
}
