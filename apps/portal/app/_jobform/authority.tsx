"use client";
// DD11, BA37: the client's written authority on an agency job: the copies kept on file (list, open) and an optional upload. The tick on the statement is the rule; a copy is extra.
// Calls GET and POST /api/portal/jobs/{id}/authority and opens GET .../authority/{docId} (a 302 to a short-lived link).
import { useEffect, useRef, useState } from "react";
import { Button, Icon, Notice } from "@portal/ui";
import { send } from "../_account/client";
import { authorityMessage } from "./words";

export type Doc = { id: string; fileName: string; contentType: string; sizeBytes: number; uploadedAt: string; copyDeleted: boolean };
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Dublin" });
const size = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The list and the upload button, from props (a test renders each state). */
export function AuthorityView({ jobId, docs, error, pending, onPick }: { jobId: string; docs: Doc[] | null; error?: string; pending?: boolean; onPick?: (f: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <section aria-labelledby="auth-h" data-card="authority" className="flex flex-col gap-3 rounded-card bg-white p-4">
      <h3 id="auth-h" className="font-semibold">Copies of the client&apos;s written authority</h3>
      <p className="text-small text-muted">Optional. Keep a copy on file (PDF, JPEG or PNG, up to 4 MB). It is deleted 30 days after the job closes.</p>
      {docs === null ? <p className="text-muted">Loading the copies.</p> : docs.length === 0 ? <p className="text-muted" data-no-docs>No copy on file yet.</p> : (
        <ul className="flex flex-col gap-2">
          {docs.map((d) => (
            <li key={d.id} data-doc={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-control bg-sand px-4 py-2">
              <span><span className="block font-semibold">{d.fileName}</span><span className="text-small text-muted">{size(d.sizeBytes)} · added {DAY.format(new Date(d.uploadedAt))}</span></span>
              {d.copyDeleted ? <span className="text-small text-muted">The copy was removed</span> : <a href={`/api/portal/jobs/${jobId}/authority/${d.id}`} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1 font-semibold text-deep-green underline-offset-2 hover:underline">Open <Icon name="external" size={16} /></a>}
            </li>
          ))}
        </ul>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      <input ref={input} type="file" accept="application/pdf,image/jpeg,image/png" hidden aria-label="Choose a copy of the written authority" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick?.(f); e.target.value = ""; }} />
      <Button type="button" variant="outline" className="self-start" disabled={pending} onClick={() => input.current?.click()}><Icon name="upload" size={16} /> {pending ? "Adding" : "Add a copy"}</Button>
    </section>
  );
}

export function Authority({ jobId }: { jobId: string }) {
  const [docs, setDocs] = useState<Doc[] | null>(null), [error, setError] = useState<string>(), [pending, setPending] = useState(false);
  useEffect(() => {
    let live = true;
    void send(`/api/portal/jobs/${jobId}/authority`, "GET").then((r) => { if (!live) return; if (r.status === 200) setDocs(r.body.documents as Doc[]); else { setDocs([]); setError(authorityMessage(r)); } });
    return () => { live = false; };
  }, [jobId]);
  async function add(file: File) {
    setPending(true); setError(undefined);
    const form = new FormData(); form.set("file", file);
    const r = await send(`/api/portal/jobs/${jobId}/authority`, "POST", form);
    setPending(false);
    if (r.status === 200) setDocs((d) => [...(d ?? []), r.body.document as Doc]); else setError(authorityMessage(r));
  }
  return <AuthorityView jobId={jobId} docs={docs} error={error} pending={pending} onPick={add} />;
}
