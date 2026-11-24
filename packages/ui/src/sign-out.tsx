"use client";
import { useState } from "react";

/** Ends the session through the app's own Better Auth route (`action`), then a full load of `to`, so nothing of the signed-in page stays on screen. */
export function SignOut({ action, to, className }: { action: string; to: string; className?: string }) {
  const [state, setState] = useState<"idle" | "pending" | "failed">("idle");
  async function onClick() {
    setState("pending");
    const ok = await fetch(action, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", credentials: "same-origin" }).then((r) => r.ok, () => false);
    if (ok) window.location.assign(to);
    else setState("failed");
  }
  return (
    <button type="button" data-sign-out={action} onClick={onClick} disabled={state === "pending"} aria-live="polite" className={className}>
      {state === "failed" ? "Sign out did not work. Try again" : "Sign out"}
    </button>
  );
}
