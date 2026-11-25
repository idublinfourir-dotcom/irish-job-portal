// The permit case pages (frames A08 and NA1's case card): the list at /account/cases and one case at /account/cases/[id]. Plain functions of their props, so a
// test renders every state; the page files read the data and the client parts (upload, withdraw) are in actions.tsx and passed in as nodes. The content
// column only: the account layout (the left menu) comes from P17a. Replaced frame wording: no handler name and no message box (CF93, #272), no "needed from"
// party on a document (CF15), the 30 day rule for copies (CF58), who pays in the decided words (CF1).
import type { ReactNode } from "react";
import { A, Button, EmptyState, Icon, Notice, Pill } from "@portal/ui";
import { ClosedNotice } from "../../permit-services/landing";
import { casePath, permitRequestPath } from "../../../lib/paths";
import {
  banner, canUpload, caseState, caseSubtitle, caseTitle, fmtDate, fmtSize, isOpen, MAX_OPEN_CASES, permitLabel, STATUS_LABEL, steps, updateLine, whoPays,
  type CaseDoc, type CaseEvent, type CaseRow,
} from "./model";

type Notice = { title: string; body: string } | null;
const STATE_PILL: Record<string, { tone: "green" | "peach" | "lilac" | "neutral"; text: string }> = {
  granted: { tone: "green", text: "Granted" }, refused: { tone: "peach", text: "Refused" }, referred: { tone: "lilac", text: "Referred" },
  withdrawn: { tone: "neutral", text: "Withdrawn" }, closed: { tone: "neutral", text: "Closed" },
};

/** One row of the list. */
function CaseCard({ c }: { c: CaseRow }) {
  const end = STATE_PILL[caseState(c, [])];
  return (
    <li>
      <A href={casePath(c.id)} className="flex flex-col gap-3 rounded-bento bg-sand p-6 no-underline hover:bg-hover-light">
        <span className="flex flex-wrap items-start justify-between gap-3">
          <span className="flex flex-col gap-1">
            <span className="font-heading text-[1.25rem] font-semibold leading-tight">{caseTitle(c)}</span>
            <span className="text-small text-muted">{[permitLabel(c.permitType), c.employerName].filter(Boolean).join(" · ")}</span>
          </span>
          {end ? <Pill tone={end.tone}>{end.text}</Pill> : <Pill tone="green">{STATUS_LABEL[c.status] ?? "Open"}</Pill>}
        </span>
        <span className="flex flex-wrap gap-x-5 gap-y-1 text-small text-muted">
          <span>Case {c.id}</span>
          <span>Last change {fmtDate(c.lastChangeAt)}</span>
          {isOpen(c) && c.documentsNeeded.length > 0 && <span className="font-semibold text-ink">{c.documentsNeeded.length} {c.documentsNeeded.length === 1 ? "document" : "documents"} needed</span>}
        </span>
      </A>
    </li>
  );
}

export function CasesView({ cases, olderHref, notice, error }: { cases: CaseRow[]; olderHref: string | null; notice: Notice; error?: string }) {
  const open = cases.filter(isOpen).length, full = open >= MAX_OPEN_CASES;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-[2rem]">Permit <span className="text-deep-green">cases</span></h1>
          <p className="text-muted">Your permit requests and where each one stands.</p>
        </div>
        {!full && !error && <Button href={permitRequestPath()} variant="dark">Start a permit request <Icon name="arrow" size={16} /></Button>}
      </div>
      <ClosedNotice notice={notice} />
      {full && <Notice kind="warning" title={`You have ${MAX_OPEN_CASES} open requests`}>That is the most we can hold at once. Wait for one to finish, or withdraw one, to start another.</Notice>}
      {error ? <Notice kind="error" title="Your requests could not be loaded">{error}</Notice> : cases.length === 0 ? (
        <EmptyState icon="file" title="You have no permit requests" action={<Button href={permitRequestPath()}>Start a permit request</Button>}>
          Got a job offer? Ask our team to check it and prepare the permit application. It is free for you.
        </EmptyState>
      ) : (
        <ul aria-label="Your permit requests" className="flex flex-col gap-3">{cases.map((c) => <CaseCard key={c.id} c={c} />)}</ul>
      )}
      {olderHref && <div><Button href={olderHref} variant="outline">Older requests <Icon name="arrow" size={16} /></Button></div>}
    </div>
  );
}

function Stepper({ c, events }: { c: CaseRow; events: CaseEvent[] }) {
  const list = steps(c, events);
  return (
    <ol aria-label="Progress" className="grid grid-cols-4">
      {list.map((s, i) => (
        <li key={s.label} aria-current={s.state === "now" && isOpen(c) ? "step" : undefined} className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center">
            <span aria-hidden="true" className={`grid size-[30px] shrink-0 place-items-center rounded-pill text-small font-semibold ${s.state === "todo" ? "bg-lilac text-ink" : "bg-deep-green text-white"}`}>
              {s.state === "done" ? <Icon name="check" size={16} /> : i + 1}
            </span>
            {i < list.length - 1 && <span aria-hidden="true" className={`h-0.5 flex-1 ${list[i + 1]!.state === "todo" ? "bg-white/30" : "bg-deep-green"}`} />}
          </div>
          <div className="flex flex-col gap-1 pr-1 text-caption sm:pr-2 sm:text-small">
            <span className="font-semibold">{s.label}</span>
            <span className="text-white/70">{s.detail}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Documents({ c, docs, upload, error }: { c: CaseRow; docs: CaseDoc[]; upload: ReactNode; error?: string }) {
  const asked = isOpen(c) ? c.documentsNeeded : [];
  return (
    <section aria-labelledby="docs-h" className="flex flex-col gap-5 rounded-bento bg-sand p-6 sm:p-8">
      <div className="flex flex-col gap-1">
        <h2 id="docs-h" className="text-[1.5rem]">Documents</h2>
        <p className="text-small text-muted">We work from the copies you upload. We keep them for 30 days after your case closes, then delete them.</p>
      </div>
      {error && <Notice kind="error" title="Your copies could not be loaded">{error}</Notice>}
      {asked.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-ui font-semibold">We asked you for</h3>
          <ul className="flex flex-col gap-2">
            {asked.map((d) => (
              <li key={d.code} className="flex items-center justify-between gap-3 rounded-card bg-white px-4 py-3">
                <span className="flex items-center gap-3 font-medium"><Icon name="file" size={18} />{d.label ?? "Another document"}</span>
                <Pill tone="peach">Needed</Pill>
              </li>
            ))}
          </ul>
        </div>
      )}
      {asked.length === 0 && docs.length === 0 && !error && <p className="text-muted">{isOpen(c) ? "Nothing is needed from you yet. We email you if that changes." : "No documents were added to this case."}</p>}
      {docs.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-ui font-semibold">Your uploaded copies</h3>
          <ul className="flex flex-col gap-2">
            {docs.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-white px-4 py-3">
                <span className="flex min-w-0 flex-col">
                  <span className="break-all font-medium">{d.fileName ?? "Removed copy"}</span>
                  <span className="text-small text-muted">{fmtSize(d.sizeBytes)} · uploaded {fmtDate(d.uploadedAt)}</span>
                </span>
                {d.copyDeleted
                  ? <Pill tone="neutral">Copy removed</Pill>
                  : <a href={`/api/candidate/cases/${encodeURIComponent(c.id)}/documents/${encodeURIComponent(d.id)}`} className="inline-flex items-center gap-2 text-small font-semibold text-deep-green underline underline-offset-2"><Icon name="download" size={16} />Open<span className="sr-only"> {d.fileName}</span></a>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {canUpload(c) ? <div className="flex flex-col gap-2">{upload}<p className="text-small font-semibold">Copies only, never originals.</p></div> : isOpen(c) ? <p className="text-small text-muted">This request is with DETE for a decision, so it takes no more documents.</p> : null}
    </section>
  );
}

export function CaseView({ c, events, docs, docsError, notice, upload, withdraw }: { c: CaseRow; events: CaseEvent[]; docs: CaseDoc[]; docsError?: string; notice: Notice; upload: ReactNode; withdraw: ReactNode }) {
  const state = caseState(c, events), b = banner(c, state), newest = [...events].reverse();
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-col gap-2">
        <A href="/account/cases" className="inline-flex items-center gap-1 text-small font-semibold text-deep-green no-underline hover:underline"><Icon name="left" size={14} />All permit cases</A>
        <h1 className="text-[2rem]">Permit case</h1>
        <p className="text-muted">{caseTitle(c) !== "Permit request" && <strong className="font-semibold text-ink">{caseTitle(c)} · </strong>}{caseSubtitle(c)}</p>
      </div>
      <ClosedNotice notice={notice} />
      <section aria-labelledby="status-h" className="flex flex-col gap-6 rounded-bento bg-ink p-6 text-white sm:p-8">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="status-h" className="text-[1.5rem] text-white">{b.title}</h2>
          {b.action && <span className="rounded-pill bg-deep-green px-3 py-1 text-small font-medium">{b.action}</span>}
        </div>
        {b.lead && <p className="max-w-xl text-white/80">{b.lead}</p>}
        <Stepper c={c} events={events} />
      </section>
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 xl:grid-cols-[minmax(0,1fr)_293px]">
        <Documents c={c} docs={docs} upload={upload} error={docsError} />
        <div className="flex flex-col gap-4">
          <aside aria-labelledby="pay-h" className="flex flex-col gap-2 rounded-bento bg-peach p-6">
            <h2 id="pay-h" className="text-ui font-semibold">Who pays</h2>
            <p>{whoPays(c.payer)}</p>
          </aside>
          <section aria-labelledby="upd-h" className="flex flex-col gap-3 rounded-bento bg-sand p-6">
            <h2 id="upd-h" className="text-[1.25rem]">Updates</h2>
            <ol className="flex flex-col">
              {newest.map((e, i) => (
                <li key={`${e.at}${i}`} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 border-t border-line py-3 text-small first:border-t-0">
                  <time dateTime={e.at} className="text-muted">{fmtDate(e.at)}</time>
                  <span>{updateLine(e)}</span>
                </li>
              ))}
              {newest.length === 0 && <li className="text-small text-muted">Nothing yet.</li>}
            </ol>
          </section>
          {withdraw}
        </div>
      </div>
    </div>
  );
}

export function CaseProblem({ message }: { message: string }) {
  return (
    <div className="flex flex-col gap-4">
      <Notice kind="error" title="This request could not be loaded">{message}</Notice>
      <div><Button href="/account/cases" variant="outline">All permit cases</Button></div>
    </div>
  );
}
