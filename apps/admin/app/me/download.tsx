"use client";
// The staff member's own data as one JSON file: GET /api/staff/me/export (docs/openapi/admin.yaml). The route needs a sign-in in the last 10 minutes and answers
// reauth_required otherwise; the page then offers to sign in again and come back. The file is made in the browser from the answer, so nothing is cached or linked.
import { useState } from "react";
import { Button, Notice } from "@portal/ui";
import { ReauthNotice } from "../_tools/reauth";
import { toolWords } from "../_tools/words";

export type State = { pending: boolean; error?: string; reauth?: boolean; done?: boolean };

export function DownloadView({ s, onDownload }: { s: State; onDownload: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      {s.reauth ? <ReauthNotice back="/me" /> : s.error ? <Notice kind="error">{s.error}</Notice> : null}
      {s.done && <Notice kind="success">The file was saved to your downloads.</Notice>}
      <Button type="button" onClick={onDownload} disabled={s.pending} className="self-start">{s.pending ? "Preparing the file" : "Download my data"}</Button>
    </div>
  );
}

export function Download() {
  const [s, set] = useState<State>({ pending: false });
  async function go() {
    set({ pending: true });
    try {
      const res = await fetch("/api/staff/me/export", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: unknown } | null;
        const code = typeof j?.error === "string" ? j.error : "";
        return set({ pending: false, error: toolWords(code, res.status), reauth: code === "reauth_required" });
      }
      const name = /filename="([\w.-]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "my-data.json";
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: name });
      a.click();
      URL.revokeObjectURL(url);
      set({ pending: false, done: true });
    } catch {
      set({ pending: false, error: toolWords("", 0) });
    }
  }
  return <DownloadView s={s} onDownload={() => void go()} />;
}
