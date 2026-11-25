"use client";
// The Confirm of /data-request: one POST to the documented route (POST /api/data-request?token=, no sign-in, Origin checked: the browser sends it). An export
// answers with the file, which is saved here; an erase answers { ok: true, purpose: "erase" }. Words in messages.ts.
import { useState } from "react";
import { dataRequestSay, exportName } from "./messages";
import { DataRequestView, type Purpose, type View } from "./views";

export function DataRequestFlow({ token, purpose, expiresAt }: { token: string; purpose: Purpose; expiresAt?: string }) {
  const [view, setView] = useState<View>("ask"), [error, setError] = useState<string>(), [pending, setPending] = useState(false);
  async function onConfirm() {
    setPending(true); setError(undefined);
    try {
      const res = await fetch(`/api/data-request?${new URLSearchParams({ token })}`, { method: "POST", credentials: "omit", referrerPolicy: "no-referrer" });
      if (res.ok && purpose === "export") {
        const url = URL.createObjectURL(await res.blob()), a = document.createElement("a");
        a.href = url; a.download = exportName(res.headers.get("content-disposition"));
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        return void setView("exported");
      }
      if (res.ok) return void setView("erased");
      const j = (await res.json().catch(() => null)) as { code?: unknown } | null, code = typeof j?.code === "string" ? j.code : undefined;
      if (res.status === 404) return void setView("invalid");
      setError(dataRequestSay({ ok: false, status: res.status, code }));
    } catch {
      setError(dataRequestSay({ ok: false, status: 0 }));
    } finally {
      setPending(false);
    }
  }
  return <DataRequestView view={view} purpose={purpose} expiresAt={expiresAt} error={error} pending={pending} onConfirm={() => void onConfirm()} />;
}
