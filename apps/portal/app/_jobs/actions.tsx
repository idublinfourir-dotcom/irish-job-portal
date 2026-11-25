"use client";
// The buttons that write: renew and close (frame E13, BA9, BA36), report (BA32, the pattern of frame C11) and "I don't recognise this job" (DD32). Each calls a documented
// route from the browser and shows the words of words.ts for every answer. The View parts take their state as props so a test renders each one.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Checkbox, Dialog, Notice, Radio, Textarea } from "@portal/ui";
import { api, type Reply } from "../(auth)/api";
import type { Answer } from "../(auth)/messages";
import { closeMessage, EVIDENCE_MAX, notRecognisedMessage, renewedWord, renewMessage, REPORT_REASONS, reportMessage, type JobState } from "./words";

const post = (url: string, body: object) => api(url, { method: "POST", body });
const asAnswer = (r: Reply): Answer => ({ status: r.status, code: r.code });

type Mode = "close" | "renew" | null;

/** The close question of frame E13: yes or no (decision #49, CF45), skipped for a draft (B52). `error` shows a refused answer. */
export function CloseView({ title, draft, canRenew, hire, onHire, error, pending, onClose, onKeep, onRenew }: {
  title: string; draft: boolean; canRenew: boolean; hire?: string; onHire?: (v: string) => void; error?: string; pending?: boolean; onClose?: () => void; onKeep?: () => void; onRenew?: () => void;
}) {
  return (
    <div className="flex flex-col gap-4" aria-busy={pending || undefined}>
      <p>{draft ? "This draft was never shown to anyone. Closing it removes it from your list." : "The job leaves search within 24 hours. Candidates who saved it or clicked to apply see \"This job has closed\"."}</p>
      {!draft && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 font-semibold">Did you hire someone through us?</legend>
          <Radio name={`hire-${title}`} label="Yes" checked={hire === "yes"} onChange={() => onHire?.("yes")} />
          <Radio name={`hire-${title}`} label="No" checked={hire === "no"} onChange={() => onHire?.("no")} />
          <p className="text-small text-muted">We ask so we can measure whether listings lead to hires. One tap, no follow-up emails.</p>
        </fieldset>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button variant="filter-on" onClick={onKeep}>Keep it live</Button>
        {canRenew && <Button variant="outline" onClick={onRenew}>Renew for 30 days instead</Button>}
        <Button variant="dark" onClick={onClose} disabled={pending || (!draft && !hire)}>{pending ? "Closing" : "Close job"}</Button>
      </div>
    </div>
  );
}

/** The renewal's answer: held, or asking for the exception tick (BA36). */
export function RenewView({ text, exception, ticked, onTick, error, pending, onRenew, onDone }: {
  text?: string; exception?: string; ticked?: boolean; onTick?: (v: boolean) => void; error?: string; pending?: boolean; onRenew?: () => void; onDone?: () => void;
}) {
  return (
    <div className="flex flex-col gap-4" aria-busy={pending || undefined}>
      {text && <Notice kind={exception === undefined ? "info" : "warning"}>{text}</Notice>}
      {exception !== undefined && (
        <>
          {exception && <p data-exception className="rounded-card bg-sand p-4">{exception}</p>}
          <Checkbox label="I confirm my company meets this exception" checked={!!ticked} onChange={(e) => onTick?.(e.target.checked)} />
        </>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      <div className="flex justify-end gap-3">
        {exception !== undefined ? <Button onClick={onRenew} disabled={pending || !ticked}>{pending ? "Renewing" : "Renew for 30 days"}</Button> : <Button variant="dark" onClick={onDone}>Done</Button>}
      </div>
    </div>
  );
}

/** Renew and Close on one job row. A viewer never gets this (the page does not render it and the routes refuse). */
export function JobActions({ id, title, state }: { id: string; title: string; state: JobState }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(null), [hire, setHire] = useState<string>(), [error, setError] = useState<string>(), [pending, setPending] = useState(false);
  const [held, setHeld] = useState<string>(), [exception, setException] = useState<string>(), [ticked, setTicked] = useState(false);
  const live = state === "live", draft = state === "draft";
  const done = () => { setMode(null); setHeld(undefined); setException(undefined); setTicked(false); setError(undefined); router.refresh(); };
  const open = (m: Mode) => { setError(undefined); setMode(m); };
  async function close() {
    setPending(true); setError(undefined);
    const r = await post("/api/portal/jobs/close", { jobId: id, ...(draft ? {} : { hireAnswer: hire }) });
    setPending(false);
    if (r.status === 200) done(); else setError(closeMessage(asAnswer(r)));
  }
  async function renew() {
    setPending(true); setError(undefined);
    const r = await post("/api/portal/jobs/renew", { jobId: id, ...(ticked ? { exceptionConfirmed: true } : {}) });
    setPending(false);
    if (r.status === 200) {
      if (r.body.status === "under_review") { setHeld(renewedWord(r.body)); setException(undefined); } else done();
    } else if (r.status === 422) { setException(typeof r.body.exception === "string" ? r.body.exception : ""); setError(undefined); }
    else setError(renewMessage(asAnswer(r)));
  }
  return (
    <>
      {live && <Button variant="chip" onClick={() => open("renew")}>Renew</Button>}
      {(live || state === "under_review" || state === "in_review" || draft) && <Button variant="chip" onClick={() => open("close")} aria-label={`Close ${title}`}>Close</Button>}
      <Dialog open={mode !== null} onClose={() => (held ? done() : setMode(null))} title={mode === "close" ? `Close "${title}"?` : `Renew "${title}"?`}>
        {mode === "close" ? (
          <CloseView title={title} draft={draft} canRenew={live} hire={hire} onHire={setHire} error={error} pending={pending} onClose={close} onKeep={() => setMode(null)} onRenew={() => { setMode("renew"); }} />
        ) : mode === "renew" && held === undefined && exception === undefined ? (
          <div className="flex flex-col gap-4">
            <p>The job runs for 30 more days from today. It is checked against the rules in force first.</p>
            {error && <Notice kind="error">{error}</Notice>}
            <div className="flex justify-end gap-3"><Button variant="filter-on" onClick={() => setMode(null)}>Cancel</Button><Button onClick={renew} disabled={pending}>{pending ? "Renewing" : "Renew for 30 days"}</Button></div>
          </div>
        ) : mode === "renew" ? (
          <RenewView text={held ?? renewMessage({ status: 422 })} exception={held === undefined ? exception : undefined} ticked={ticked} onTick={setTicked} error={error} pending={pending} onRenew={renew} onDone={done} />
        ) : null}
      </Dialog>
    </>
  );
}

/** Report one job or one company (BA32). `target` is the id of the one thing reported; the reasons are that target's own (docs/openapi/portal.yaml). */
export function ReportView({ kind, reason, onReason, evidence, onEvidence, error, sent, pending, onSend, onCancel }: {
  kind: "job" | "company"; reason?: string; onReason?: (v: string) => void; evidence?: string; onEvidence?: (v: string) => void; error?: string; sent?: boolean; pending?: boolean; onSend?: () => void; onCancel?: () => void;
}) {
  if (sent) return <div className="flex flex-col gap-4"><Notice kind="success" title="Report sent">A person reviews every report with the evidence. A single report never triggers action on its own.</Notice><div className="flex justify-end"><Button variant="dark" onClick={onCancel}>Done</Button></div></div>;
  return (
    <div className="flex flex-col gap-4" aria-busy={pending || undefined}>
      <p>Tell us what is wrong. A person reviews every report. Whoever reports is never shown to the other side.</p>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 font-semibold">What is wrong?</legend>
        {REPORT_REASONS[kind].map(([code, label]) => <Radio key={code} name="reason" label={label} checked={reason === code} onChange={() => onReason?.(code)} />)}
      </fieldset>
      <Textarea label="What happened? (optional)" value={evidence ?? ""} onChange={(e) => onEvidence?.(e.target.value)} maxLength={EVIDENCE_MAX} help="Who asked for what, and how they contacted you." />
      {error && <Notice kind="error">{error}</Notice>}
      <div className="flex justify-end gap-3"><Button variant="filter-on" onClick={onCancel}>Cancel</Button><Button variant="dark" onClick={onSend} disabled={pending || !reason}>{pending ? "Sending" : "Send report"}</Button></div>
    </div>
  );
}

export function ReportButton({ kind, id, label = "Report" }: { kind: "job" | "company"; id: string; label?: string }) {
  const [open, setOpen] = useState(false), [reason, setReason] = useState<string>(), [evidence, setEvidence] = useState(""), [error, setError] = useState<string>();
  const [sent, setSent] = useState(false), [pending, setPending] = useState(false);
  async function send() {
    setPending(true); setError(undefined);
    const text = evidence.trim();
    const r = await post("/api/portal/report", { [kind === "job" ? "jobId" : "companyId"]: id, reason, ...(text ? { evidence: text } : {}) });
    setPending(false);
    if (r.status === 200) setSent(true); else setError(reportMessage(asAnswer(r)));
  }
  return (
    <>
      <Button variant="chip" onClick={() => { setOpen(true); setSent(false); setError(undefined); }}>{label}</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={kind === "job" ? "Report this job" : "Report this company"}>
        <ReportView kind={kind} reason={reason} onReason={setReason} evidence={evidence} onEvidence={setEvidence} error={error} sent={sent} pending={pending} onSend={send} onCancel={() => setOpen(false)} />
      </Dialog>
    </>
  );
}

/** "I don't recognise this job" on an agency job (DD32, owner only): hides a live job at once and reports it; no strike. */
export function NotRecognisedButton({ id }: { id: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [error, setError] = useState<string>(), [pending, setPending] = useState(false);
  async function send() {
    setPending(true); setError(undefined);
    const r = await post("/api/portal/agency-jobs/not-recognised", { jobId: id });
    setPending(false);
    if (r.status === 200) { setOpen(false); router.refresh(); } else setError(notRecognisedMessage(asAnswer(r)));
  }
  return (
    <>
      <Button variant="chip" onClick={() => { setOpen(true); setError(undefined); }}>I do not recognise this job</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="You do not recognise this job?">
        <div className="flex flex-col gap-4">
          <p>We hide the job from search at once and send it to our team to check. No strike is added to the agency and nobody is emailed.</p>
          {error && <Notice kind="error">{error}</Notice>}
          <div className="flex justify-end gap-3"><Button variant="filter-on" onClick={() => setOpen(false)}>Cancel</Button><Button variant="dark" onClick={send} disabled={pending}>{pending ? "Sending" : "Hide and report it"}</Button></div>
        </div>
      </Dialog>
    </>
  );
}
