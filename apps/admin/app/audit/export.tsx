"use client";
// The Export button: downloads the rows of the current filters from GET /api/audit/export (a CSV file, at most 2,000 rows, one audit row of its own). That route wants a sign-in from the
// last 10 minutes (C4), so its refusal comes back as words with the sign-in link. A plain link could not show that, so the file is fetched here and saved.
import { useState } from "react";
import { Button, Icon, Notice } from "@portal/ui";
import { Failure } from "../_queue/failure";

export type Shown = { failed: { code: string; status: number } | null; truncated: boolean };

export function ExportView({ pending, shown, back, onClick }: { pending: boolean; shown: Shown; back: string; onClick: () => void }) {
  return (
    <div className="flex flex-col items-end gap-2">
      <Button type="button" variant="chip" size="md" onClick={onClick} disabled={pending}><Icon name="download" size={16} />{pending ? "Exporting" : "Export"}</Button>
      {shown.failed && <Failure code={shown.failed.code} status={shown.failed.status} back={back} />}
      {shown.truncated && <Notice kind="warning">More than 2,000 rows matched, so the file holds the newest 2,000. Narrow the filters to get the rest.</Notice>}
    </div>
  );
}

export function ExportButton({ query, back }: { query: string; back: string }) {
  const [pending, setPending] = useState(false);
  const [shown, setShown] = useState<Shown>({ failed: null, truncated: false });
  async function go() {
    setPending(true); setShown({ failed: null, truncated: false });
    try {
      const res = await fetch(`/api/audit/export${query ? `?${query}` : ""}`, { credentials: "same-origin" });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: unknown } | null;
        return setShown({ failed: { code: typeof j?.error === "string" ? j.error : "", status: res.status }, truncated: false });
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url; a.download = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "audit.csv";
      a.click(); URL.revokeObjectURL(url);
      setShown({ failed: null, truncated: res.headers.get("x-audit-export-truncated") === "1" });
    } catch {
      setShown({ failed: { code: "", status: 0 }, truncated: false });
    } finally {
      setPending(false);
    }
  }
  return <ExportView pending={pending} shown={shown} back={back} onClick={() => void go()} />;
}
