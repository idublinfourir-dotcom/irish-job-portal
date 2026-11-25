"use client";
// The Confirm of /unsubscribe: one POST to the documented route (POST /api/alerts/unsubscribe?token=&scope=, no sign-in, no Origin check). Its words are in messages.ts.
import { useState } from "react";
import { unsubscribeSay } from "./messages";
import { UnsubscribeView, type Alert, type View } from "./views";

export function UnsubscribeFlow({ token, scope, alert, otherHref }: { token: string; scope: "one" | "all"; alert: Alert | null; otherHref?: string }) {
  const [view, setView] = useState<View>("ask"), [error, setError] = useState<string>(), [pending, setPending] = useState(false);
  async function onConfirm() {
    setPending(true); setError(undefined);
    let r: { ok: boolean; status: number; code?: string };
    try {
      const res = await fetch(`/api/alerts/unsubscribe?${new URLSearchParams({ token, scope })}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click", credentials: "omit", referrerPolicy: "no-referrer" });
      const j = (await res.json().catch(() => null)) as { code?: unknown } | null;
      r = { ok: res.ok, status: res.status, code: typeof j?.code === "string" ? j.code : undefined };
    } catch {
      r = { ok: false, status: 0 };
    }
    setPending(false);
    if (r.ok) return void setView("done");
    setError(unsubscribeSay(r));
  }
  return <UnsubscribeView view={view} scope={scope} alert={alert} otherHref={otherHref} error={error} pending={pending} onConfirm={() => void onConfirm()} />;
}
