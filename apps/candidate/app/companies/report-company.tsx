"use client";
// "Report this company" (BA23, decision #259): a signed-in candidate opens the form; a visitor is sent to log in first. One open report a login (409), 10 an hour (429).
import { useState } from "react";
import { A, Button, Icon, Notice } from "@portal/ui";
import { COMPANY_REASONS, EVIDENCE_MAX, reportCompany } from "../_content/api";
import { loginHref } from "../jobs/format";
import { MODAL_BODY, MODAL_FOOT, Modal } from "../jobs/modal";

const LINK = "inline-flex min-h-11 items-center gap-2 rounded-pill px-3 text-small font-semibold text-muted hover:text-ink";

export function ReportCompany({ companyId, name, signedIn, path }: { companyId: string; name: string; signedIn: boolean; path: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "sending" } | { kind: "done" } | { kind: "error"; message: string }>({ kind: "idle" });
  if (!signedIn) return <A href={loginHref(path)} className={LINK}><Icon name="flag" size={16} />Log in to report this company</A>;
  const close = () => { setOpen(false); setState({ kind: "idle" }); };
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason) return setState({ kind: "error", message: "Choose what is wrong first." });
    setState({ kind: "sending" });
    const r = await reportCompany(companyId, reason, evidence);
    setState(r.ok ? { kind: "done" } : { kind: "error", message: r.message });
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={LINK}><Icon name="flag" size={16} />Report this company</button>
      {open && (
        <Modal onClose={close} title="Report this company">
          {state.kind === "done" ? (
            <>
              <div className={MODAL_BODY}><Notice kind="success" title="Thank you. We have your report.">A person reviews every report with the evidence. A single report never triggers action on its own.</Notice></div>
              <div className={MODAL_FOOT}><Button onClick={close}>Close</Button></div>
            </>
          ) : (
            <form onSubmit={submit}>
              <div className={MODAL_BODY}>
                <p className="text-muted">Tell us what is wrong with &ldquo;{name}&rdquo;. A person reviews every report with the evidence. A single report never triggers action on its own.</p>
                <fieldset className="flex flex-col gap-2">
                  <legend className="sr-only">What is wrong?</legend>
                  {COMPANY_REASONS.map(([code, label]) => (
                    <label key={code} className="flex min-h-[52px] cursor-pointer items-center gap-3 rounded-pill bg-white px-5 has-[:checked]:ring-2 has-[:checked]:ring-ink">
                      <input type="radio" name="reason" value={code} checked={reason === code} onChange={() => setReason(code)} className="size-5 accent-ink" />
                      {label}
                    </label>
                  ))}
                </fieldset>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="report-company-evidence" className="text-small font-semibold">What happened? (optional)</label>
                  <textarea id="report-company-evidence" rows={4} maxLength={EVIDENCE_MAX} value={evidence} onChange={(e) => setEvidence(e.target.value)} className="w-full rounded-control border-[1.5px] border-line bg-white px-5 py-4 text-ink placeholder:text-faint focus:border-ink" />
                </div>
                {state.kind === "error" && <Notice kind="error">{state.message}</Notice>}
              </div>
              <div className={MODAL_FOOT}>
                <Button variant="filter-on" size="md" onClick={close} className="sm:order-1">Cancel</Button>
                <button type="submit" disabled={state.kind === "sending"} className="inline-flex min-h-[42px] items-center justify-center gap-2 rounded-pill bg-error px-5 text-small font-semibold text-white hover:opacity-90 disabled:opacity-60 sm:order-2"><Icon name="flag" size={16} />Send report</button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </>
  );
}
