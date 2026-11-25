"use client";
// The buttons of the account pages (everything else is server rendered). Each one calls a documented route through jobs/api.ts `send`, then refreshes the page
// from the server; a refusal is worded (messages.ts), never swallowed. An ended session (DD3) offers the sign-in page and comes back to this page.
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { A, Button, Icon, Radio, Select, Input } from "@portal/ui";
import { send, type Sent } from "../jobs/api";
import { COUNTIES, SECTORS } from "../jobs/format";
import { alertsPath, loginPath } from "../../lib/paths";
import { MOVE_TO, STAGE_TEXT, wording } from "./messages";

/** Runs one write; `busy` while it runs, `error` after a refusal (with `code`), refreshes the page on success. */
function useAct() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ code: string; text: string }>();
  async function act(call: () => Promise<Sent>, after?: () => void) {
    setBusy(true);
    setErr(undefined);
    const r = await call();
    setBusy(false);
    if (!r.ok) return setErr({ code: r.code, text: wording(r.code) });
    if (after) after();
    else router.refresh();
  }
  return { act, busy, err, router };
}

export function ErrorLine({ err }: { err?: { code: string; text: string } }) {
  if (!err) return null;
  return (
    <p role="alert" className="mt-1 text-small font-semibold text-error">
      {err.text}
      {err.code === "NO_SESSION" && <> <A href={loginPath(typeof window === "undefined" ? undefined : window.location.pathname + window.location.search)} className="underline">Log in</A></>}
    </p>
  );
}

// ===== "Did you apply?" (#49): only a "Yes" puts the job in the tracker =====
export function DidYouApply({ clickId, jobTitle, employer, when }: { clickId: string; jobTitle: string; employer: string; when: string | null }) {
  const { act, busy, err } = useAct();
  const answer = (a: "yes" | "not_yet") => act(() => send("POST", "/api/candidate/did-you-apply", { clickId, answer: a }));
  return (
    <section aria-labelledby="dya" className="flex flex-col gap-3 rounded-bento bg-peach p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
      <div className="min-w-0">
        <h2 id="dya" className="text-[18px] leading-snug">Did you apply for {jobTitle} at {employer}?</h2>
        <p className="text-small">{when ? `You opened the employer's site ${when}. ` : ""}Only &quot;Yes&quot; adds it to your tracker.</p>
        <ErrorLine err={err} />
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="chip" className="bg-white" disabled={busy} onClick={() => answer("not_yet")}>Not yet</Button>
        <Button variant="dark" disabled={busy} onClick={() => answer("yes")}><Icon name="check" size={16} /> Yes, I applied</Button>
      </div>
    </section>
  );
}

// ===== tracker =====
/** A row on the employer's own site is moved by the candidate; the allowed stages are the route's (a stage it refuses comes back as a worded refusal). */
export function StageSelect({ jobId, title, stage }: { jobId: string; title: string; stage: string }) {
  const { act, busy, err } = useAct();
  return (
    <div>
      <Select label="Stage" aria-label={`Stage of ${title}`} value={stage} disabled={busy} onChange={(e) => act(() => send("PUT", "/api/candidate/tracker", { jobId, stage: e.target.value }))} className="min-h-10 text-small sm:min-h-10">
        {!(MOVE_TO as readonly string[]).includes(stage) && <option value={stage}>{STAGE_TEXT[stage] ?? stage}</option>}
        {MOVE_TO.map((s) => <option key={s} value={s}>{STAGE_TEXT[s]}</option>)}
      </Select>
      <ErrorLine err={err} />
    </div>
  );
}
export function WithdrawButton({ jobId }: { jobId: string }) {
  const { act, busy, err } = useAct();
  return (
    <span>
      <Button variant="outline" disabled={busy} onClick={() => act(() => send("PUT", "/api/candidate/tracker", { jobId, stage: "withdrawn" }))}>Withdraw from list</Button>
      <ErrorLine err={err} />
    </span>
  );
}

// ===== alerts =====
/** On or off: pause an active alert, resume a paused or unsubscribed one. A Stamp 4 pause cannot be resumed (the route says STAMP_4); the page then says why. */
export function AlertToggle({ id, label, on }: { id: string; label: string; on: boolean }) {
  const { act, busy, err } = useAct();
  return (
    <span className="flex flex-col items-end">
      <input type="checkbox" role="switch" aria-label={on ? `Pause alert: ${label}` : `Resume alert: ${label}`} checked={on} disabled={busy}
        onChange={() => act(() => send("POST", on ? "/api/candidate/alerts/pause" : "/api/candidate/alerts/resume", { id }))}
        className="relative h-6 w-11 shrink-0 cursor-pointer appearance-none rounded-pill bg-line before:absolute before:left-0.5 before:top-0.5 before:size-5 before:rounded-pill before:bg-white before:transition-transform checked:bg-deep-green checked:before:translate-x-5 disabled:opacity-60" />
      <ErrorLine err={err} />
    </span>
  );
}
export function DeleteAlert({ id, label }: { id: string; label: string }) {
  const { act, busy, err } = useAct();
  const [ask, setAsk] = useState(false);
  if (!ask) return <button type="button" aria-label={`Delete alert: ${label}`} onClick={() => setAsk(true)} className="grid size-11 place-items-center rounded-pill hover:bg-white"><Icon name="trash" size={18} /></button>;
  return (
    <span className="flex items-center gap-1">
      <Button variant="danger" size="sm" disabled={busy} onClick={() => act(() => send("DELETE", "/api/candidate/alerts", { id }))}>Delete</Button>
      <Button variant="chip" disabled={busy} onClick={() => setAsk(false)}>Keep</Button>
      <ErrorLine err={err} />
    </span>
  );
}

type AlertValues = { id?: string; occupationCode: string | null; sector: string | null; county: string | null; salaryMin: number | null; badge: string | null; frequency: string };
const BADGES = [["", "Both badges"], ["sponsor_confirmed", "Sponsor confirmed only"], ["critical_skills_eligible", "Critical Skills eligible only"]] as const;

/** The alert builder: exactly the filters the route takes (one occupation, one sector, one county, a salary, one badge) and how often. Creates, or with `alert` edits. */
export function AlertForm({ alert, occupations, full }: { alert?: AlertValues; occupations: { code: string; title: string }[]; full?: boolean }) {
  const { act, busy, err, router } = useAct();
  const [bad, setBad] = useState<string>();
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const text = (k: string) => String(f.get(k) ?? "").trim();
    const salary = text("salaryMin");
    if (salary && !/^[0-9]{1,7}$/.test(salary)) return setBad("Enter the salary as whole euros, for example 32000.");
    if (salary && Number(salary) > 1_000_000) return setBad("The most you can enter is 1,000,000.");
    setBad(undefined);
    const body: Record<string, string | number> = { frequency: text("frequency") === "daily" ? "daily" : "weekly" };
    for (const k of ["occupationCode", "sector", "county", "badge"]) if (text(k)) body[k] = text(k);
    if (salary) body.salaryMin = Number(salary);
    if (alert?.id) body.id = alert.id;
    act(() => send(alert?.id ? "PUT" : "POST", "/api/candidate/alerts", body), () => (alert?.id ? router.push(alertsPath()) : (form.reset(), router.refresh())));
  }
  return (
    <form id="new-alert" onSubmit={submit} className="scroll-mt-4 rounded-bento bg-sand p-5 sm:p-6" aria-labelledby="alert-form-h">
      <h2 id="alert-form-h" className="mb-4 text-[20px]">{alert?.id ? "Edit alert" : "New alert"}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <Select label="Occupation" name="occupationCode" defaultValue={alert?.occupationCode ?? ""}>
          <option value="">Any occupation</option>
          {occupations.map((o) => <option key={o.code} value={o.code}>{o.title}</option>)}
        </Select>
        <Select label="Sector" name="sector" defaultValue={alert?.sector ?? ""}>
          <option value="">Any sector</option>
          {SECTORS.map((s) => <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>)}
        </Select>
        <Select label="County" name="county" icon="pin" defaultValue={alert?.county ?? ""}>
          <option value="">All counties</option>
          {COUNTIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Input label="Salary from (a year, optional)" name="salaryMin" inputMode="numeric" icon="euro" placeholder="Any" defaultValue={alert?.salaryMin ?? ""} error={bad} />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-small font-semibold">Badge</legend>
          {BADGES.map(([v, l]) => <Radio key={v} name="badge" value={v} label={l} defaultChecked={(alert?.badge ?? "") === v} />)}
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-small font-semibold">How often</legend>
          <Radio name="frequency" value="daily" label="Daily" defaultChecked={alert?.frequency === "daily"} />
          <Radio name="frequency" value="weekly" label="Weekly" defaultChecked={alert?.frequency !== "daily"} />
        </fieldset>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button type="submit" variant="dark" size="lg" disabled={busy || (full && !alert?.id)}>{alert?.id ? "Save alert" : "Create alert"}</Button>
        {alert?.id && <A href={alertsPath()} className="font-semibold underline underline-offset-2">Cancel</A>}
      </div>
      <ErrorLine err={err} />
    </form>
  );
}

// ===== notices =====
export function MarkSeen({ id }: { id?: string }) {
  const { act, busy, err } = useAct();
  return (
    <span>
      <Button variant={id ? "chip" : "outline"} disabled={busy} onClick={() => act(() => send("POST", "/api/candidate/notices", id ? { action: "read", id } : { action: "read_all" }))}>{id ? "Mark as read" : "Mark all as read"}</Button>
      <ErrorLine err={err} />
    </span>
  );
}
