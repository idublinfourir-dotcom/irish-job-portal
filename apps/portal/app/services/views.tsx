// The employer's permit services pages (frames E17 and A08): the list at /services and one case at /services/[id]. Plain functions of their props, so a test renders every state; the
// page files read the data and the client parts (upload, withdraw) are in actions.tsx and passed in as nodes. Copied from the candidate's case pages with the employer's wording:
// no handler name and no message box (CF93), no "needed from" party on a document (CF15), the 30 day rule for copies (CF58), our fee in the decided words (CF1), the job only on a card (L7).
import type { ReactNode } from "react";
import { A, Button, EmptyState, Icon, Notice, Pager, Pill } from "@portal/ui";
import {
  asked, banner, canUpload, caseState, caseSubtitle, caseTitle, fmtDate, fmtSize, isOpen, MAX_OPEN_CASES, permitFeeLabel, permitLabel, SERVICE_FEE, STATUS_LABEL, steps, updateLine,
  type CaseDoc, type CaseEvent, type CaseRow,
} from "./model";

export type Notice = { title: string; body: string } | null;
/** The notice from the read (the permit notice), or null when it is off or has no text. */
export const noticeOf = (data: unknown): Notice => {
  const n = data as { title?: unknown; body?: unknown } | null;
  return n && typeof n.title === "string" && typeof n.body === "string" ? { title: n.title, body: n.body } : null;
};
/** The notice staff switch on while DETE's Employment Permits portal is closed (#291). The text is staff's own plain text; it is never HTML. */
export const ClosedNotice = ({ notice }: { notice: Notice }) => notice && <Notice kind="closed" title={notice.title}><span className="whitespace-pre-line">{notice.body}</span></Notice>;

const STATE_PILL: Record<string, { tone: "green" | "peach" | "lilac" | "neutral"; text: string }> = {
  granted: { tone: "green", text: "Granted" }, refused: { tone: "peach", text: "Refused" }, referred: { tone: "lilac", text: "Referred" },
  withdrawn: { tone: "neutral", text: "Withdrawn" }, closed: { tone: "neutral", text: "Closed" },
};

/** The page of a login whose role may not ask for permit services (a poster or a viewer): no read is made. */
export function RoleRefused() {
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <h1>Permit services</h1>
      <Notice kind="info" title="Not open to your role">Permit services are for the account owner and recruiters of a verified company. Ask the account owner to change your role, or to open this page.</Notice>
    </div>
  );
}

function CaseCard({ c }: { c: CaseRow }) {
  const end = STATE_PILL[caseState(c, [])];
  return (
    <li>
      <A href={`/services/${encodeURIComponent(c.id)}`} className="flex flex-col gap-3 rounded-bento bg-sand p-6 no-underline hover:bg-hover-light">
        <span className="flex flex-wrap items-start justify-between gap-3">
          <span className="flex flex-col gap-1">
            <span className="font-heading text-[1.25rem] font-semibold leading-tight">{caseTitle(c)}</span>
            <span className="text-small text-muted">{permitLabel(c.permitType)}</span>
          </span>
          {end ? <Pill tone={end.tone}>{end.text}</Pill> : <Pill tone={c.status === "documents_needed" || c.status === "waiting_for_employer" ? "peach" : "green"}>{STATUS_LABEL[c.status] ?? "Open"}</Pill>}
        </span>
        <span className="flex flex-wrap gap-x-5 gap-y-1 text-small text-muted">
          <span>Case {c.id}</span>
          <span>Last change {fmtDate(c.lastChangeAt)}</span>
          <span className="font-semibold text-deep-green">{isOpen(c) && c.status === "documents_needed" ? "Upload documents" : "Open case"}</span>
        </span>
        <Stepper c={c} events={[]} light />
      </A>
    </li>
  );
}

function Side({ permitType }: { permitType?: string }) {
  return (
    <div className={permitType ? "flex flex-col gap-4" : "grid gap-4 md:grid-cols-2"}>
      <aside aria-labelledby="pay-h" className="flex flex-col gap-2 rounded-bento bg-peach p-6">
        <h2 id="pay-h" className="text-ui font-semibold">Payment</h2>
        <p>{SERVICE_FEE}</p>
        {permitType ? <p className="text-small">DETE&apos;s permit fee for this permit: {permitFeeLabel(permitType)}.</p> : <p className="text-small">DETE&apos;s permit fee: {permitFeeLabel("critical_skills")} for Critical Skills, {permitFeeLabel("general").toLowerCase()} for General.</p>}
      </aside>
      {!permitType && (
        <section aria-labelledby="what-h" className="flex flex-col gap-2 rounded-bento bg-ink p-6 text-white">
          <h2 id="what-h" className="text-ui font-semibold text-white">What we handle</h2>
          <p className="text-small text-white/75">EPOS set-up, application handling, Labour Market Needs Test guidance and renewals.</p>
        </section>
      )}
    </div>
  );
}

export function CasesView({ cases, prevHref, nextHref, notice, error }: { cases: CaseRow[]; prevHref?: string; nextHref: string | null; notice: Notice; error?: string }) {
  const full = cases.filter(isOpen).length >= MAX_OPEN_CASES;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1>Permit services</h1>
          <p className="text-muted">Cases our team is handling for you.</p>
        </div>
        {!error && <Button href="/services/request" variant="dark">New request <Icon name="arrow" size={16} /></Button>}
      </div>
      <ClosedNotice notice={notice} />
      {full && <Notice kind="warning" title={`You have ${MAX_OPEN_CASES} open cases`}>That is the most one login can have open at once. A new request is refused until one finishes or is withdrawn.</Notice>}
      <div className="flex flex-col gap-4">
        {error ? <Notice kind="error" title="Your cases could not be loaded">{error}</Notice> : cases.length === 0 ? (
          <EmptyState icon="file" title="No permit cases yet" action={<Button href="/services/request">New request</Button>}>
            Ask our team to prepare a permit application for a hire. You get a free check of the pay rule first.
          </EmptyState>
        ) : (
          <ul aria-label="Permit cases" className="flex flex-col gap-3">{cases.map((c) => <CaseCard key={c.id} c={c} />)}</ul>
        )}
        <Side />
      </div>
      {!error && (prevHref || nextHref) && <Pager prevHref={prevHref} nextHref={nextHref ?? undefined} />}
    </div>
  );
}

function Stepper({ c, events, light }: { c: CaseRow; events: CaseEvent[]; light?: boolean }) {
  const list = steps(c, events);
  return (
    <ol aria-label="Progress" className="grid grid-cols-4">
      {list.map((s, i) => (
        <li key={s.label} aria-current={s.state === "now" && isOpen(c) ? "step" : undefined} className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center">
            <span aria-hidden="true" className={`grid size-[30px] shrink-0 place-items-center rounded-pill text-small font-semibold ${s.state === "todo" ? "bg-lilac text-ink" : "bg-deep-green text-white"}`}>
              {s.state === "done" ? <Icon name="check" size={16} /> : i + 1}
            </span>
            {i < list.length - 1 && <span aria-hidden="true" className={`h-0.5 flex-1 ${list[i + 1]!.state !== "todo" ? "bg-deep-green" : light ? "bg-line" : "bg-white/30"}`} />}
          </div>
          <div className="flex flex-col gap-1 pr-1 text-caption sm:pr-2 sm:text-small">
            <span className="font-semibold">{s.label}</span>
            {!light && <span className="text-white/70">{s.detail}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** `requester`: this login asked for the case, so it holds the copies (they are personal): it sees them, adds more and withdraws. Anyone else of the company reads the case only. */
function Documents({ c, events, docs, requester, upload, error }: { c: CaseRow; events: CaseEvent[]; docs: CaseDoc[]; requester: boolean; upload: ReactNode; error?: string }) {
  const need = asked(c, events);
  return (
    <section aria-labelledby="docs-h" className="flex flex-col gap-5 rounded-bento bg-sand p-6 sm:p-8">
      <div className="flex flex-col gap-1">
        <h2 id="docs-h" className="text-[1.5rem]">Documents</h2>
        <p className="text-small text-muted">We work from the copies uploaded. We keep them for 30 days after the case closes, then delete them.</p>
      </div>
      {error && <Notice kind="error" title="The copies could not be loaded">{error}</Notice>}
      {need.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-ui font-semibold">We asked you for</h3>
          <ul className="flex flex-col gap-2">
            {need.map((d) => (
              <li key={d.code} className="flex items-center justify-between gap-3 rounded-card bg-white px-4 py-3">
                <span className="flex items-center gap-3 font-medium"><Icon name="file" size={18} />{d.label ?? "Another document"}</span>
                <Pill tone="peach">Needed</Pill>
              </li>
            ))}
          </ul>
        </div>
      )}
      {need.length === 0 && docs.length === 0 && !error && <p className="text-muted">{isOpen(c) ? "Nothing is needed from you yet. We email you if that changes." : "No documents were added to this case."}</p>}
      {docs.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-ui font-semibold">Uploaded copies</h3>
          <ul className="flex flex-col gap-2">
            {docs.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-white px-4 py-3">
                <span className="flex min-w-0 flex-col">
                  <span className="break-all font-medium">{d.fileName ?? "Removed copy"}</span>
                  <span className="text-small text-muted">{fmtSize(d.sizeBytes)} · uploaded {fmtDate(d.uploadedAt)}</span>
                </span>
                {d.copyDeleted
                  ? <Pill tone="neutral">Copy removed</Pill>
                  : <a href={`/api/portal/cases/${encodeURIComponent(c.id)}/documents/${encodeURIComponent(d.id)}`} className="inline-flex items-center gap-2 text-small font-semibold text-deep-green underline underline-offset-2"><Icon name="download" size={16} />Open<span className="sr-only"> {d.fileName}</span></a>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!requester ? <p className="text-small text-muted">Copies belong to the person who asked for this case. They add and open them.</p> : canUpload(c) ? upload : isOpen(c) ? <p className="text-small text-muted">This case is with DETE for a decision, so it takes no more documents.</p> : null}
    </section>
  );
}

export function CaseView({ c, events, docs, docsError, requester, notice, upload, withdraw }: {
  c: CaseRow; events: CaseEvent[]; docs: CaseDoc[]; docsError?: string; requester: boolean; notice: Notice; upload: ReactNode; withdraw: ReactNode;
}) {
  const state = caseState(c, events), b = banner(c, state, asked(c, events).length), newest = [...events].reverse();
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-col gap-2">
        <A href="/services" className="inline-flex items-center gap-1 text-small font-semibold text-deep-green no-underline hover:underline"><Icon name="left" size={14} />All permit cases</A>
        <h1>Permit case</h1>
        <p className="text-muted">{c.jobTitle && <strong className="font-semibold text-ink">{c.jobTitle} · </strong>}{caseSubtitle(c)}</p>
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
        <Documents c={c} events={events} docs={docs} requester={requester} upload={upload} error={docsError} />
        <div className="flex flex-col gap-4">
          <Side permitType={c.permitType} />
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
          {requester && isOpen(c) && withdraw}
        </div>
      </div>
    </div>
  );
}

export function CaseProblem({ message }: { message: string }) {
  return (
    <div className="flex flex-col gap-4">
      <Notice kind="error" title="This case could not be loaded">{message}</Notice>
      <div><Button href="/services" variant="outline">All permit cases</Button></div>
    </div>
  );
}
