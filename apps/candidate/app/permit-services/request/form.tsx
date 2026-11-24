"use client";
// The permit request form: sends the request to the documented route (POST /api/candidate/cases), then, on the result screen, the copies the candidate adds
// (POST /api/candidate/cases/{id}/documents). The browser sends the Origin header both routes check. Every answer code has its words in (auth)/messages.ts.
import { useState, type FormEvent } from "react";
import { say, type Res } from "../../(auth)/messages";
import { casePath } from "../../../lib/paths";
import { buildRequest } from "./build";
import { MAX_FILE_BYTES, RequestView, ResultView, type Doc, type FreeCheck, type JobPrefill, type Occupation, type Who } from "./views";

async function send(url: string, init: RequestInit): Promise<Res & { body: Record<string, unknown> | null }> {
  try {
    const res = await fetch(url, { ...init, credentials: "same-origin" });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok, status: res.status, code: typeof body?.code === "string" ? body.code : undefined, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

export function RequestFlow({ occupations, job, employersHref, notice }: { occupations: Occupation[]; job: JobPrefill | null; employersHref: string | null; notice: { title: string; body: string } | null }) {
  const [who, setWho] = useState<Who>("candidate"), [degree, setDegree] = useState<"yes" | "no" | null>(null);
  const [error, setError] = useState<string>(), [unverified, setUnverified] = useState(false), [pending, setPending] = useState(false);
  const [done, setDone] = useState<{ id: string; freeCheck: FreeCheck } | null>(null), [docs, setDocs] = useState<Doc[]>([]), [uploading, setUploading] = useState(false), [uploadError, setUploadError] = useState<string>();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setPending(true); setError(undefined); setUnverified(false);
    const r = await send("/api/candidate/cases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(buildRequest(f, job?.id ?? null)) });
    setPending(false);
    if (r.ok) {
      const b = r.body as { case: { id: string }; freeCheck: FreeCheck };
      return void setDone({ id: b.case.id, freeCheck: b.freeCheck });
    }
    const s = say("request", r);
    setUnverified(s.screen === "check-email");
    setError(s.text);
  }
  async function onFiles(files: FileList | null) {
    if (!files || !done) return;
    setUploading(true); setUploadError(undefined);
    for (const file of Array.from(files)) {
      if (file.size > MAX_FILE_BYTES) { setUploadError(say("upload", { ok: false, status: 413, code: "FILE_TOO_LARGE" }).text); break; }
      const body = new FormData();
      body.set("file", file);
      const r = await send(`/api/candidate/cases/${encodeURIComponent(done.id)}/documents`, { method: "POST", body });
      const d = r.body?.document as { fileName?: string; sizeBytes?: number } | undefined;
      if (!r.ok || !d) { setUploadError(say("upload", r).text); break; }
      setDocs((x) => [...x, { fileName: d.fileName ?? file.name, sizeBytes: d.sizeBytes ?? file.size }]);
    }
    setUploading(false);
  }
  if (done) return <ResultView caseHref={casePath(done.id)} jobLine={job ? `About the ${job.title} job at ${job.employerName}.` : null} freeCheck={done.freeCheck} docs={docs} uploading={uploading} uploadError={uploadError} notice={notice} onFiles={onFiles} />;
  return <RequestView who={who} onWho={setWho} occupations={occupations} job={job} degree={degree} onDegree={setDegree} notice={notice} employersHref={employersHref} error={error} flashCheckEmail={unverified} pending={pending} onSubmit={onSubmit} />;
}
