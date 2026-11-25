// Frame E20: the account status page. A presentational part: every value arrives from GET /api/portal/status, so a test renders every state. It never shows a report, a reporter or evidence
// (#99, #220; CF101: no "See the evidence"). Copy rows: CF49 the appeal window is what the read says, CF73 the instant ban reworded to what happens, CF74 the notice is the staff summary.
import type { ReactNode } from "react";
import { Icon, Notice, Pill } from "@portal/ui";
import { day } from "../_account/messages";
import { CaseText } from "./forms";

export type Case = {
  id: string; caseKind: string; reasonCode: string | null; jobTitle: string | null; noticeSummary: string | null; stage: string; outcome: string | null; level: number | string | null;
  createdAt?: string | null; notifiedAt?: string | null; replyDueAt: string | null; employerReply: string | null; repliedAt: string | null; decidedAt: string | null; appealDueAt: string | null;
  appealText: string | null; appealedAt: string | null; appealDecidedAt: string | null; canReply: boolean; canAppeal: boolean;
};
export type StatusPage = { status: string; restrictedUntil: string | null; claimsRemovedAt: string | null; isOwner: boolean; strikesLast12Months: number; cases: Case[] };

const REASON: Record<string, string> = {
  false_sponsorship: "A job said sponsorship was confirmed when it was not.",
  false_pay_floor: "A job paid below the minimum it needs.",
  asks_for_money: "Candidates were asked for money.",
  fake_company: "The company was not genuine.",
  fake_job: "A job was not genuine.",
};

/** What a case's stage and outcome say, as a short pill. */
export function caseState(c: Case): { text: string; tone: "peach" | "green" | "lilac" | "neutral" } {
  if (c.stage === "upheld") return { text: "Appeal decided: decision kept", tone: "neutral" };
  if (c.stage === "overturned") return { text: "Appeal decided: decision overturned", tone: "green" };
  if (c.stage === "appealed" || (c.appealedAt && !c.appealDecidedAt)) return { text: "Appeal sent", tone: "lilac" };
  if (c.decidedAt) return { text: c.outcome === "cleared" ? "Decided: no strike" : c.outcome === "ban" ? "Decided: account banned" : "Decided: strike applied", tone: c.outcome === "cleared" ? "green" : "peach" };
  return { text: c.repliedAt || c.employerReply ? "Reply sent, waiting for a decision" : c.canReply ? "Waiting for your reply" : "Open", tone: "peach" };
}

function Step({ state, n, title, children }: { state: "done" | "now" | "todo"; n: number; title: string; children?: ReactNode }) {
  return (
    <li data-step-state={state} className="relative flex gap-3 sm:flex-col sm:gap-2">
      {n < 5 && <span aria-hidden="true" className={`absolute left-9 right-0 top-[17px] hidden h-0.5 sm:block ${state === "done" ? "bg-deep-green" : "bg-line"}`} />}
      <span aria-hidden="true" className={`relative grid size-9 shrink-0 place-items-center rounded-pill text-small font-semibold ${state === "done" ? "bg-deep-green text-white" : state === "now" ? "border-2 border-deep-green bg-white text-deep-green" : "border border-line bg-white text-muted"}`}>{state === "done" ? <Icon name="check" size={16} /> : n}</span>
      <span><span className="block text-small font-semibold">{title}</span><span className="block text-small text-muted">{children}</span></span>
    </li>
  );
}

function Timeline({ c }: { c: Case }) {
  const appealed = !!c.appealedAt, decided = !!c.decidedAt, replied = !!c.repliedAt || !!c.employerReply; // a reply staff recorded for the company has its text and no time of its own
  return (
    <ol aria-label="Where the case is" className="grid gap-4 sm:grid-cols-5">
      <Step n={1} state="done" title="Case opened">{day(c.createdAt) ?? ""}</Step>
      <Step n={2} state={c.notifiedAt ? "done" : "todo"} title="You were told">{day(c.notifiedAt) ?? "Not yet"}</Step>
      <Step n={3} state={replied ? "done" : decided ? "todo" : "now"} title="Your reply">{replied ? day(c.repliedAt) ?? "Received" : decided ? "No reply sent" : c.replyDueAt ? `Reply by ${day(c.replyDueAt)}` : "Not open"}</Step>
      <Step n={4} state={decided ? "done" : "todo"} title="Decision">{day(c.decidedAt) ?? "Not yet"}</Step>
      <Step n={5} state={c.appealDecidedAt ? "done" : appealed ? "now" : "todo"} title="Appeal">{c.appealDecidedAt ? day(c.appealDecidedAt) : appealed ? `Sent ${day(c.appealedAt) ?? ""}` : c.canAppeal && c.appealDueAt ? `Until ${day(c.appealDueAt)}` : decided ? "One appeal allowed" : "After a decision"}</Step>
    </ol>
  );
}

function CaseCard({ c, isOwner }: { c: Case; isOwner: boolean }) {
  const s = caseState(c);
  return (
    <article data-case={c.id} className="flex flex-col gap-5 rounded-bento bg-sand p-6 sm:p-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-[22px]">Case {c.id}{c.jobTitle ? ` · ${c.jobTitle}` : ""}</h2>
        <Pill tone={s.tone}>{s.text}</Pill>
      </header>
      {(c.reasonCode && REASON[c.reasonCode]) && <p className="text-muted">{REASON[c.reasonCode]}</p>}
      {c.noticeSummary && <p data-summary className="whitespace-pre-line text-muted">{c.noticeSummary}</p>}
      <Timeline c={c} />
      {c.employerReply && <div data-reply className="rounded-card bg-white p-4"><p className="text-small font-semibold">Your reply</p><p className="mt-1 whitespace-pre-line text-muted">{c.employerReply}</p></div>}
      {c.appealText && <div data-appeal className="rounded-card bg-white p-4"><p className="text-small font-semibold">Your appeal</p><p className="mt-1 whitespace-pre-line text-muted">{c.appealText}</p></div>}
      {c.canReply && isOwner && <CaseText caseId={c.id} kind="reply" until={day(c.replyDueAt)} />}
      {c.canAppeal && isOwner && <CaseText caseId={c.id} kind="appeal" until={day(c.appealDueAt)} />}
      {(c.canReply || c.canAppeal) && !isOwner && <p className="text-small text-muted">Only the account owner can {c.canReply ? "reply" : "appeal"}. Ask them to open this page.</p>}
    </article>
  );
}

const STEPS = [
  { n: 1, text: "A job is removed and you get a warning." },
  { n: 2, text: "The sponsor confirmed badge is removed from your jobs for a set time, and new jobs are checked by our team before they go live." },
  { n: 3, text: "The account is banned. The company page says sponsorship claims were removed." },
];

export function StatusView({ p }: { p: StatusPage }) {
  const strikes = Math.min(p.strikesLast12Months, 3);
  const ended = ["suspended", "banned", "rejected", "closed"].includes(p.status);
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1>Account status</h1>
        <p className="mt-1 text-muted">Strikes, warnings and appeals. A person on our team reviews every case, and each one shows how long you have to reply.</p>
      </header>
      {p.status === "suspended" && <Notice kind="error" title="This account is suspended">Your jobs are hidden while we look into it. Reply to the open case below, if there is one.</Notice>}
      {p.status === "banned" && <Notice kind="error" title="This account is banned">The company page says sponsorship claims were removed. If you think this is wrong, appeal below when a case allows it, or use the contact form on the Help page.</Notice>}
      {p.status === "closed" && <Notice kind="info" title="This company is closed">Nothing new can be posted.</Notice>}
      {p.status === "verified_restricted" && <Notice kind="warning" title="This account is restricted">{p.restrictedUntil ? `Until ${day(p.restrictedUntil)}, a` : "A"} new job is checked by our team before it goes live.</Notice>}
      {p.claimsRemovedAt && <Notice kind="warning" title="Sponsorship claims removed">Since {day(p.claimsRemovedAt)} your company page shows that sponsorship claims were removed.</Notice>}
      <section aria-labelledby="standing-h" className="rounded-bento bg-ink p-6 text-white sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="standing-h" className="text-[26px]">{strikes === 0 ? "Good standing" : `Strike ${strikes} of 3`}</h2>
            {strikes > 0 && <Pill tone="green">{strikes === 1 ? "Warning" : strikes === 2 ? "Restricted" : "Banned"}</Pill>}
          </div>
          <p className="text-small text-white/70">Strikes count for 12 months</p>
        </div>
        {strikes === 0 && !ended && <p className="mt-2 text-white/80">No strikes. Your jobs show the badges they earned.</p>}
        <ol className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-3">
          {STEPS.map((s) => <li key={s.n} data-strike={s.n} data-on={strikes === s.n} className={`rounded-bento p-5 ${strikes === s.n ? "bg-peach text-ink" : "bg-ink-hover text-white/80"}`}><span className="block font-semibold">Strike {s.n}</span><span className="block text-small">{s.text}</span></li>)}
        </ol>
      </section>
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-6">
          {p.cases.length === 0 ? <p data-empty className="rounded-bento bg-sand p-6 text-muted">No cases. When our team opens one about your company, it shows here with what to do next.</p> : p.cases.map((c) => <CaseCard key={c.id} c={c} isOwner={p.isOwner} />)}
        </div>
        <aside aria-label="What counts" className="flex flex-col gap-4">
          <div className="rounded-bento bg-error-tint p-5"><p className="flex items-center gap-2 font-semibold"><Icon name="warning" size={20} />Instant ban</p><p className="mt-2 text-small">Asking candidates for money, or a fake company or job, hides your jobs and suspends the account at once. A ban can follow: it covers the CRO number and the email domain.</p></div>
        </aside>
      </div>
    </div>
  );
}
