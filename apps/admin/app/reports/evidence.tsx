"use client";
// Attach the one evidence file of a report or a case (PDF, JPEG or PNG up to 4 MB, once): a multipart POST to /api/trust-safety/evidence. The route checks the role, the Origin, the
// size and type and the scan; its refusals show in words. EvidenceView takes its state as props so a test renders every state.
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Notice } from "@portal/ui";
import { ErrorNote } from "../_queue/act";
import { staffWords } from "../_queue/staff-words";

export type EvidenceState = { pending: boolean; error?: { code: string; text: string } };

export function EvidenceView({ s, here, onSubmit }: { s: EvidenceState; here: string; onSubmit: (e: FormEvent<HTMLFormElement>) => void }) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3" aria-busy={s.pending || undefined}>
      <label className="flex flex-col gap-1 text-small font-semibold">
        Attach the evidence file
        <input type="file" name="file" required accept="application/pdf,image/jpeg,image/png" className="text-body font-normal" />
        <span className="font-normal text-muted">PDF, JPEG or PNG, up to 4 MB. One file, and it cannot be replaced.</span>
      </label>
      {s.error && <ErrorNote error={s.error} here={here} />}
      <Button type="submit" variant="outline" disabled={s.pending} className="self-start">Attach</Button>
    </form>
  );
}

/** `query` is `reportId=12` or `caseId=12`, made by the page from its own checked id. */
export function Evidence({ query, here }: { query: string; here: string }) {
  const router = useRouter();
  const [s, set] = useState<EvidenceState>({ pending: false });
  const [done, setDone] = useState(false);
  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    set({ pending: true });
    try {
      const res = await fetch(`/api/trust-safety/evidence?${query}`, { method: "POST", body: new FormData(form), credentials: "same-origin" });
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) return set({ pending: false, error: { code: j?.error ?? "", text: staffWords(j?.error ?? "", res.status) } });
    } catch {
      return set({ pending: false, error: { code: "", text: staffWords("", 0) } });
    }
    set({ pending: false });
    setDone(true);
    router.refresh();
  }
  return done ? <Notice kind="success">The file is attached.</Notice> : <EvidenceView s={s} here={here} onSubmit={(e) => void send(e)} />;
}
