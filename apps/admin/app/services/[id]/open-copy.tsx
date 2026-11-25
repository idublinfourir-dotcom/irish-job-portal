"use client";
// Opens one stored copy through its route (GET /api/services/cases/{id}/documents/{docId}), never a direct link: the route checks the role and the assignment, the virus
// scan, and writes the audit row. The list does not say what the scan found, so a copy that is pending or blocked is learned at the first try and then shows its state
// with no button. Plain bytes open in a new tab from the answer.
import { useState } from "react";
import { Button } from "@portal/ui";
import { words } from "../text";

export type OpenState = "idle" | "opening" | "scan_pending" | "file_blocked" | { error: string };

export function OpenCopyView({ state, onOpen, name }: { state: OpenState; onOpen: () => void; name: string }) {
  if (state === "scan_pending") return <span className="text-small text-muted">Being checked</span>;
  if (state === "file_blocked") return <span className="text-small font-semibold text-error">Blocked</span>;
  return (
    <span className="flex flex-col items-start gap-1">
      <Button type="button" variant="outline" size="md" onClick={onOpen} disabled={state === "opening"} aria-label={`Open the copy ${name}`}>Open</Button>
      {typeof state === "object" && <span role="alert" className="text-small text-error">{state.error}</span>}
    </span>
  );
}

export function OpenCopy({ caseId, docId, name }: { caseId: string; docId: string; name: string }) {
  const [state, set] = useState<OpenState>("idle");
  async function open() {
    set("opening");
    try {
      const res = await fetch(`/api/services/cases/${encodeURIComponent(caseId)}/documents/${encodeURIComponent(docId)}`, { credentials: "same-origin" });
      if (res.ok) {
        const url = URL.createObjectURL(await res.blob());
        window.open(url, "_blank", "noopener");
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return set("idle");
      }
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      const code = typeof j?.error === "string" ? j.error : "";
      set(code === "scan_pending" || code === "file_blocked" ? code : { error: words(code, res.status) });
    } catch {
      set({ error: words("", 0) });
    }
  }
  return <OpenCopyView state={state} onOpen={() => void open()} name={name} />;
}
