"use client";
// The two writes of the case page: add a copy (POST /api/portal/cases/{id}/documents) and withdraw (POST /api/portal/cases/{id}/withdraw). The browser sends the Origin header both
// routes check; each answer code has its words (messages.ts). The page reloads its data after a success. Withdraw asks once more before it sends.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Icon, Notice } from "@portal/ui";
import { say } from "./messages";

export const MAX_FILE_BYTES = 4_194_304; // the upload route's own limit (4 MiB)
type Sent = { ok: boolean; status: number; code?: string; body: Record<string, unknown> | null };
export async function send(url: string, body?: FormData | object): Promise<Sent> {
  try {
    const form = body instanceof FormData;
    const res = await fetch(url, { method: "POST", credentials: "same-origin", headers: body && !form ? { "content-type": "application/json" } : undefined, body: body ? (form ? body : JSON.stringify(body)) : undefined });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok, status: res.status, code: typeof json?.code === "string" ? json.code : undefined, body: json };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

/** The file picker and its words (shared by the case page and the request result screen). */
export function Picker({ busy, error, onFiles }: { busy: boolean; error?: string; onFiles: (files: FileList | null) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <label className="flex cursor-pointer flex-col gap-2 rounded-card border-[1.5px] border-dashed border-line-strong bg-white p-5 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ink">
        <span className="flex items-center gap-3 font-semibold"><Icon name="upload" size={20} />Add a copy</span>
        <span className="text-small text-muted">PDF, JPG or PNG, up to 4 MB each.</span>
        <input type="file" name="file" multiple accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" disabled={busy} onChange={(e) => onFiles(e.currentTarget.files)} className="w-full min-w-0 max-w-full text-small" />
      </label>
      <p className="text-small font-semibold">Copies only, never originals.</p>
      {busy && <p role="status" className="text-small text-muted">Uploading</p>}
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  );
}

/** Uploads each file in turn; stops at the first refusal. Returns what was stored (name and size) and the message of the refusal, if any. */
export async function uploadAll(caseId: string, files: FileList): Promise<{ stored: { fileName: string; sizeBytes: number }[]; error?: string }> {
  const stored: { fileName: string; sizeBytes: number }[] = [];
  for (const file of Array.from(files)) {
    if (file.size > MAX_FILE_BYTES) return { stored, error: say({ status: 413, code: "FILE_TOO_LARGE" }) };
    const body = new FormData();
    body.set("file", file);
    const r = await send(`/api/portal/cases/${encodeURIComponent(caseId)}/documents`, body);
    const d = r.body?.document as { fileName?: string; sizeBytes?: number } | undefined;
    if (!r.ok || !d) return { stored, error: say(r) };
    stored.push({ fileName: d.fileName ?? file.name, sizeBytes: d.sizeBytes ?? file.size });
  }
  return { stored };
}

export function UploadBox({ caseId }: { caseId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true); setError(undefined);
    const r = await uploadAll(caseId, files);
    setError(r.error); setBusy(false);
    router.refresh();
  }
  return <Picker busy={busy} error={error} onFiles={(f) => void onFiles(f)} />;
}

export function WithdrawButton({ caseId }: { caseId: string }) {
  const router = useRouter();
  const [ask, setAsk] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  async function go() {
    setBusy(true); setError(undefined);
    const r = await send(`/api/portal/cases/${encodeURIComponent(caseId)}/withdraw`);
    setBusy(false);
    if (r.ok) return void router.refresh();
    setError(say(r));
  }
  return (
    <div className="flex flex-col gap-3 rounded-bento border border-line p-6">
      {!ask ? (
        <>
          <p className="text-small text-muted">Changed your mind? You can withdraw this request. Our team stops work on it.</p>
          <div><Button variant="outline" onClick={() => setAsk(true)}>Withdraw this request</Button></div>
        </>
      ) : (
        <>
          <p className="font-semibold">Withdraw this request?</p>
          <p className="text-small text-muted">This closes the request. You can start a new one later.</p>
          <div className="flex flex-wrap gap-3">
            <Button variant="danger" disabled={busy} onClick={() => void go()}>{busy ? "Withdrawing" : "Yes, withdraw"}</Button>
            <Button variant="outline" disabled={busy} onClick={() => setAsk(false)}>Keep it</Button>
          </div>
        </>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  );
}
