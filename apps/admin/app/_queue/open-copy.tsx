"use client";
// Opens one stored file through its staff route, never a direct link: the route checks the role, the virus scan and writes the audit row. The lists do not say what the scan
// found, so a copy that is pending or blocked is learned at the first try and then shows its state with no button. Plain bytes open in a new tab from the answer, so a refusal
// is words on this page and never a page of JSON. Used by the services case, the agency authority, the report and case evidence, the pay-deal evidence and the sponsor confirmation.
import { useState } from "react";
import { Button } from "@portal/ui";
import { staffWords } from "./staff-words";

export type OpenState = "idle" | "opening" | "scan_pending" | "file_blocked" | { error: string };

const WORDS: Record<string, string> = {
  not_found: "That file is not stored any more.", document_not_found: "That copy is no longer on this case.",
  not_assigned: "This case is another handler's, so only they can do this.", not_case_handler: "Only the services case handler the case is assigned to can do this.",
  not_rules_viewer: "Your roles do not let you open this file.", not_sponsor_staff: "Your roles do not let you open this file.",
};
export const openWords = (code: string, status: number): string => (status !== 0 && WORDS[code]) || staffWords(code, status);

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

/** `url` is the file route's own path, made by the page from ids it read. */
export function OpenCopy({ url, name }: { url: string; name: string }) {
  const [state, set] = useState<OpenState>("idle");
  async function open() {
    set("opening");
    try {
      const res = await fetch(url, { credentials: "same-origin" });
      if (res.ok) {
        const blob = URL.createObjectURL(await res.blob());
        window.open(blob, "_blank", "noopener");
        setTimeout(() => URL.revokeObjectURL(blob), 60_000);
        return set("idle");
      }
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      const code = typeof j?.error === "string" ? j.error : "";
      set(code === "scan_pending" || code === "file_blocked" ? code : { error: openWords(code, res.status) });
    } catch {
      set({ error: openWords("", 0) });
    }
  }
  return <OpenCopyView state={state} onOpen={() => void open()} name={name} />;
}
