"use client";
// The interactive parts of the job pages: save, report, the apply card with the "Did you apply?" prompt, and the alert builder.
// Everything else on the pages is server rendered. Every write goes through api.ts (the documented routes); a refusal is worded, never swallowed.
import { useEffect, useRef, useState } from "react";
import { A, Button, Icon, Notice, cx } from "@portal/ui";
import { EVIDENCE_MAX, REPORT_REASONS, answerPrompt, createAlert, logApplyClick, markApplied, reportJob, saveJob } from "./api";
import { loginHref } from "./format";
import { MODAL_BODY, MODAL_FOOT, Modal } from "./modal";
import { Logo } from "./parts";

// ===== save =====
/** The round bookmark of a card, or (`label`) the outlined "Save" button of the apply card. */
export function SaveButton({ jobId, title, saved: initial, label, className }: { jobId: string; title: string; saved: boolean; label?: boolean; className?: string }) {
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function toggle() {
    setBusy(true);
    setError(undefined);
    const r = await saveJob(jobId, !saved);
    setBusy(false);
    if (r.ok) setSaved(!saved);
    else setError(r.message);
  }
  return (
    <span className={cx("inline-flex flex-col", label ? "flex-1 items-stretch" : "items-start", className)}>
      <button
        type="button"
        disabled={busy}
        aria-pressed={saved}
        aria-label={saved ? `Saved: ${title}. Remove it` : `Save ${title}`}
        onClick={toggle}
        className={cx(
          "inline-flex shrink-0 items-center justify-center gap-2 rounded-pill font-semibold",
          label ? "min-h-[42px] border-[1.5px] border-white px-5 text-small text-white hover:bg-white/10" : "size-11",
          !label && (saved ? "bg-deep-green text-white" : "bg-white text-ink hover:bg-hover-light"),
        )}
      >
        <Icon name="bookmark" size={label ? 16 : 18} className={saved ? "fill-current" : undefined} />
        {label && (saved ? "Saved" : "Save")}
      </button>
      {error && <span role="alert" className="mt-1 max-w-48 text-small font-semibold text-error">{error}</span>}
    </span>
  );
}

// ===== report (C11): a candidate only (#259); no file upload (Q42) =====
const REPORT_LINK = "inline-flex min-h-[46px] w-full items-center justify-center gap-2 rounded-pill border-[1.5px] border-error px-5 font-semibold text-error no-underline hover:bg-error-hover";
export function ReportJob({ jobId, title, signedIn, path, compact }: { jobId: string; title: string; signedIn: boolean; path: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>("");
  const [evidence, setEvidence] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "sending" } | { kind: "done" } | { kind: "error"; message: string }>({ kind: "idle" });
  if (!signedIn) return <A href={loginHref(path)} className={REPORT_LINK}>Log in to report this job</A>;
  const close = () => { setOpen(false); setState({ kind: "idle" }); };
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason) return setState({ kind: "error", message: "Choose what is wrong first." });
    setState({ kind: "sending" });
    const r = await reportJob(jobId, reason, evidence);
    setState(r.ok ? { kind: "done" } : { kind: "error", message: r.message });
  }
  return (
    <>
      {compact ? (
        <button type="button" onClick={() => setOpen(true)} aria-label={`Report ${title}`} className="grid size-11 shrink-0 place-items-center rounded-pill text-ink hover:bg-white">
          <Icon name="flag" size={18} />
        </button>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className={REPORT_LINK}>
          <Icon name="flag" size={16} />
          Report this job
        </button>
      )}
      {open && (
        <Modal onClose={close} title="Report this job">
          {state.kind === "done" ? (
            <>
              <div className={MODAL_BODY}>
                <Notice kind="success" title="Thank you. We have your report.">A person reviews every report with the evidence. A single report never triggers action on its own.</Notice>
              </div>
              <div className={MODAL_FOOT}><Button onClick={close}>Close</Button></div>
            </>
          ) : (
            <form onSubmit={submit}>
              <div className={MODAL_BODY}>
                <p className="text-muted">Tell us what is wrong with &ldquo;{title}&rdquo;. A person reviews every report with the evidence. A single report never triggers action on its own.</p>
                <fieldset className="flex flex-col gap-2">
                  <legend className="sr-only">What is wrong?</legend>
                  {REPORT_REASONS.map(([code, label]) => (
                    <label key={code} className="flex min-h-[52px] cursor-pointer items-center gap-3 rounded-pill bg-white px-5 has-[:checked]:ring-2 has-[:checked]:ring-ink">
                      <input type="radio" name="reason" value={code} checked={reason === code} onChange={() => setReason(code)} className="size-5 accent-ink" />
                      {label}
                    </label>
                  ))}
                </fieldset>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="report-evidence" className="text-small font-semibold">What happened? (optional)</label>
                  <textarea id="report-evidence" rows={4} maxLength={EVIDENCE_MAX} value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Who asked for money, how much, and how they contacted you." className="w-full rounded-control border-[1.5px] border-line bg-white px-5 py-4 text-ink placeholder:text-faint focus:border-ink" />
                </div>
                {state.kind === "error" && <Notice kind="error">{state.message}</Notice>}
              </div>
              <div className={MODAL_FOOT}>
                <Button variant="filter-on" size="md" onClick={close} className="sm:order-1">Cancel</Button>
                <button type="submit" disabled={state.kind === "sending"} className="inline-flex min-h-[42px] items-center justify-center gap-2 rounded-pill bg-error px-5 text-small font-semibold text-white hover:opacity-90 disabled:opacity-60 sm:order-2">
                  <Icon name="flag" size={16} />
                  Send report
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </>
  );
}

// ===== apply, mark applied, save, and the "Did you apply?" prompt (N03, NM3, C10, M05) =====
type Prompt = { clickId: string; title: string; employerName: string; county: string | null };
const MY_PROMPTS = "/api/candidate/did-you-apply";
const ON_DARK = "border-white text-white hover:bg-white/10 active:bg-white/20";

export function JobActions({ jobId, title, applyUrl, unavailable, signedIn, saved, stage, prompt, path }: {
  jobId: string; title: string; applyUrl: string | null; unavailable: string; signedIn: boolean; saved: boolean; stage: string | null; prompt: Prompt | null; path: string;
}) {
  const [applied, setApplied] = useState(stage !== null);
  const [asking, setAsking] = useState<Prompt | null>(prompt);
  const [error, setError] = useState<string>();
  const clicked = useRef(false);

  // After the candidate went to the employer's page, ask when they come back to this tab (the click is logged first, so the prompt exists).
  useEffect(() => {
    if (!signedIn) return;
    const back = async () => {
      if (!clicked.current || document.visibilityState !== "visible") return;
      clicked.current = false;
      const res = await fetch(MY_PROMPTS, { credentials: "same-origin" }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { prompts?: { clickId: string; jobId: string; title: string; employerName: string; county: string | null }[] } | null;
      const mine = body?.prompts?.find((p) => p.jobId === jobId);
      if (mine) setAsking({ clickId: mine.clickId, title: mine.title, employerName: mine.employerName, county: mine.county });
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, [signedIn, jobId]);

  const onApply = () => {
    if (!signedIn) return; // a visitor just follows the link; nothing is logged (#287)
    clicked.current = true;
    void logApplyClick(jobId); // fire and forget: the link opens either way (keepalive lets the request finish)
  };
  async function mark() {
    setError(undefined);
    const r = await markApplied(jobId);
    if (r.ok) setApplied(true);
    else setError(r.message);
  }
  async function answer(a: "yes" | "not_yet" | "no") {
    if (!asking) return;
    const r = await answerPrompt(asking.clickId, a);
    if (!r.ok && r.code !== "CLICK_NOT_FOUND") return setError(r.message);
    if (a === "yes" && r.ok) setApplied(true);
    setAsking(null);
  }

  const apply = (cls: string) =>
    applyUrl && (
      <Button href={applyUrl} target="_blank" rel="noopener noreferrer" onClick={onApply} size="lg" className={cls}>
        Apply on employer&rsquo;s site
        <Icon name="external" size={16} />
      </Button>
    );
  const appliedMark = (
    <span className="inline-flex min-h-[42px] flex-1 items-center justify-center gap-1.5 text-small font-semibold">
      <Icon name="check" size={16} />
      Applied
    </span>
  );
  return (
    <>
      <section aria-labelledby="apply" data-apply-card className="flex flex-col gap-4 rounded-bento bg-ink p-6 text-white max-lg:hidden">
        <h2 id="apply" className="text-[22px] text-white">Apply on the employer&rsquo;s site</h2>
        {applyUrl ? (
          <>
            <p className="text-small text-white/75">
              We send you to their page. {signedIn ? "When you come back we ask if you applied, so you can track it." : "Log in first if you want us to track it."}
            </p>
            {apply("w-full")}
            {signedIn ? (
              <div className="flex gap-3">
                {applied ? appliedMark : <Button variant="outline" onClick={mark} className={cx("flex-1", ON_DARK)}><Icon name="check" size={16} />Mark applied</Button>}
                <SaveButton jobId={jobId} title={title} saved={saved} label />
              </div>
            ) : (
              <p className="text-small text-white/75">
                <A href={loginHref(path)} className="font-semibold text-white underline underline-offset-2">Log in</A> or <A href="/signup" className="font-semibold text-white underline underline-offset-2">create a free account</A> to save this job and track your application.
              </p>
            )}
          </>
        ) : (
          <p className="text-small text-white/75">{unavailable}</p>
        )}
        {error && <Notice kind="error">{error}</Notice>}
      </section>
      {/* Phones: the sticky bar of frame NM3 (the card above is hidden below 1024 px). */}
      {applyUrl && (
        <div data-apply-bar className="fixed inset-x-3 bottom-3 z-20 flex flex-wrap items-center gap-2 rounded-bento bg-white p-2 shadow-pop lg:hidden">
          {signedIn && (applied ? (
            <span className="inline-flex min-h-[42px] items-center gap-1.5 px-3 text-small font-semibold"><Icon name="check" size={16} />Applied</span>
          ) : (
            <Button variant="outline" onClick={mark}><Icon name="check" size={16} />Mark applied</Button>
          ))}
          {apply("flex-1 min-w-0 px-4!")}
          {error && <p role="alert" className="w-full px-2 text-small font-semibold text-error">{error}</p>}
        </div>
      )}
      {asking && (
        <Modal onClose={() => setAsking(null)} title="Did you apply?">
          <div className={MODAL_BODY}>
            <div className="flex items-center gap-4 px-1 py-2">
              <Logo name={asking.employerName} className="size-12" />
              <div className="min-w-0">
                <p className="break-words font-semibold">{asking.title}</p>
                <p className="break-words text-small">{[asking.employerName, asking.county].filter(Boolean).join(" · ")}</p>
              </div>
            </div>
            <p className="text-muted">You opened the employer&rsquo;s site for this job. If you applied, we will add it to your tracker. A click alone never counts.</p>
          </div>
          <div className={MODAL_FOOT}>
            <Button variant="dark" size="md" onClick={() => answer("yes")} className="max-sm:order-1 sm:order-3"><Icon name="check" size={16} />Yes, I applied</Button>
            <Button variant="filter-on" size="md" onClick={() => answer("not_yet")} className="max-sm:order-2 max-sm:min-h-[52px] sm:order-1">Not yet</Button>
            <Button variant="filter-on" size="md" onClick={() => answer("no")} className="max-sm:order-3 max-sm:min-h-[44px] max-sm:bg-transparent! max-sm:text-deep-green sm:order-2">No, not for me</Button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ===== the alert builder (C04): the filters the alert can hold, from the search =====
const CHIP = "inline-flex items-center rounded-pill bg-lilac px-3 py-1 text-small font-medium text-ink";
export function AlertBuilder({ filters, summary, signedIn, path, canSave = true }: { filters: Record<string, string | number>; summary: string[]; signedIn: boolean; path: string; canSave?: boolean }) {
  const [frequency, setFrequency] = useState<"daily" | "weekly">("daily");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "sending" } | { kind: "done" } | { kind: "error"; message: string }>({ kind: "idle" });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState({ kind: "sending" });
    const r = await createAlert(filters, frequency);
    setState(r.ok ? { kind: "done" } : { kind: "error", message: r.message });
  }
  const chips = summary.length ? summary.map((s) => <span key={s} className={CHIP}>{s}</span>) : <span className="text-small text-white/75">Every job (no filters chosen)</span>;
  return (
    <section id="alert" aria-labelledby="alert-h" className="flex flex-col gap-4 rounded-bento bg-ink p-6 text-white sm:p-7 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 flex-col gap-3">
        <h2 id="alert-h" className="text-[22px] text-white">Get new jobs like these by email</h2>
        <p className="text-small text-white/75">Pre-filled from your search. Unsubscribe in one click from every alert.</p>
        <p className="flex flex-wrap items-center gap-2">{chips}</p>
      </div>
      {!signedIn ? (
        <Button href={loginHref(path)} variant="outline" size="lg" className={cx("shrink-0", ON_DARK)}>Sign in to create an alert</Button>
      ) : !canSave ? (
        <p className="max-w-xs text-small text-white/75">An alert keeps a sector, county, occupation, salary from or badge, not a keyword. Pick one of those to save an alert.</p>
      ) : state.kind === "done" ? (
        <p role="status" className="max-w-xs text-small">Alert created. We will email you new jobs like these. <A href="/account/alerts" className="font-semibold text-white underline underline-offset-2">Manage your alerts</A>.</p>
      ) : (
        <form onSubmit={submit} aria-label="Create alert" className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center">
          <fieldset className="flex rounded-pill bg-lilac p-1 text-ink">
            <legend className="sr-only">How often</legend>
            {(["daily", "weekly"] as const).map((f) => (
              <label key={f} className="cursor-pointer rounded-pill px-4 py-1.5 text-small font-semibold has-[:checked]:bg-white">
                <input type="radio" name="frequency" value={f} checked={frequency === f} onChange={() => setFrequency(f)} className="sr-only" />
                {f === "daily" ? "Daily" : "Weekly"}
              </label>
            ))}
          </fieldset>
          <Button type="submit" variant="sun" size="lg" disabled={state.kind === "sending"}><Icon name="bell" size={16} />Create alert</Button>
          {state.kind === "error" && <p role="alert" className="text-small font-semibold text-peach">{state.message}</p>}
        </form>
      )}
    </section>
  );
}
