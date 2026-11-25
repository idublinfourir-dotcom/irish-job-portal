"use client";
// The permit request form: sends the request to the documented route (POST /api/portal/cases), then, on the result screen, the copies the employer adds (POST /api/portal/cases/{id}/documents).
// The browser sends the Origin header both routes check. Every answer code has its words in ../messages.ts. The idempotency key is made once when the form opens, so a second click or a
// retry after a lost answer opens the same case, never a second one.
import { useState, type FormEvent } from "react";
import { send, uploadAll } from "../actions";
import { say } from "../messages";
import { buildRequest } from "./build";
import { RequestView, ResultView, type Doc, type FreeCheck, type LiveJob, type Occupation } from "./views";

export function RequestFlow({ occupations, jobs, notice }: { occupations: Occupation[]; jobs: LiveJob[]; notice: { title: string; body: string } | null }) {
  const [key] = useState(() => crypto.randomUUID()), [degree, setDegree] = useState<"yes" | "no" | null>(null);
  const [error, setError] = useState<string>(), [pending, setPending] = useState(false);
  const [done, setDone] = useState<{ id: string; freeCheck: FreeCheck } | null>(null), [docs, setDocs] = useState<Doc[]>([]), [uploading, setUploading] = useState(false), [uploadError, setUploadError] = useState<string>();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setPending(true); setError(undefined);
    const r = await send("/api/portal/cases", buildRequest(f, key));
    setPending(false);
    if (r.ok) {
      const b = r.body as unknown as { case: { id: string }; freeCheck: FreeCheck };
      return void setDone({ id: b.case.id, freeCheck: b.freeCheck });
    }
    setError(say(r));
  }
  async function onFiles(files: FileList | null) {
    if (!files?.length || !done) return;
    setUploading(true); setUploadError(undefined);
    const r = await uploadAll(done.id, files);
    setDocs((x) => [...x, ...r.stored]); setUploadError(r.error); setUploading(false);
  }
  if (done) return <ResultView caseHref={`/services/${encodeURIComponent(done.id)}`} freeCheck={done.freeCheck} docs={docs} uploading={uploading} uploadError={uploadError} notice={notice} onFiles={(f) => void onFiles(f)} />;
  return <RequestView occupations={occupations} jobs={jobs} degree={degree} onDegree={setDegree} notice={notice} error={error} pending={pending} onSubmit={(e) => void onSubmit(e)} />;
}
