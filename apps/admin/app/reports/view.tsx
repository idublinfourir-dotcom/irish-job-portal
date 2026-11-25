// Reports and strikes (frame D08) as parts that take their data as props, so a test renders every state. The page (page.tsx) reads and hands them over. Every action is an Act (a documented
// POST; the route checks the role, the Origin and, for a decision, a fresh sign-in again). Text from candidates and employers is shown as text only.
import { A, EmptyState, Icon, Notice, Pager, Pill, cx } from "@portal/ui";
import { Act } from "../_queue/act";
import { ageText, when } from "../_queue/age";
import { OpenCopy } from "../_queue/open-copy";
import { CheckRow, CountTabs } from "../_queue/tabs";
import { Evidence } from "./evidence";
import { type CaseItem, type Counts, href, isTab, iso, kindText, outcomeText, PENDING_KIND, reasonText, type ReportItem, type Row, stateText, type Tab, TABS, timeline } from "./text";

export { isTab, TABS };
export const CAP = 200;
const count = (n: number) => (n >= CAP ? `${CAP}+` : String(n));
const CASES = "/api/trust-safety/cases", REPORTS = "/api/trust-safety/reports";
const TONE: Record<string, "peach" | "green" | "neutral"> = { New: "green", "Job hidden": "neutral", Appeal: "peach" };

export function List({ tab, items, selected, now, next, prev }: { tab: Tab; items: Row[]; selected?: string; now: Date; next?: string; prev?: string }) {
  if (items.length === 0)
    return <EmptyState icon="flag" title={tab === "open" ? "Nothing is open" : tab === "waiting" ? "No case is waiting for a reply" : tab === "appeals" ? "No appeal is waiting" : "Nothing closed yet"}>Reports and cases appear here as they come in.</EmptyState>;
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-card border border-line bg-white">
        <div aria-hidden="true" className="hidden grid-cols-[5rem_minmax(0,1.6fr)_minmax(0,1fr)_4rem_minmax(0,1fr)_3rem] gap-3 border-b border-line px-4 py-3 text-small font-semibold sm:grid">
          <span>Case</span><span>Reported</span><span>Reason</span><span>Reports</span><span>State</span><span className="text-right">Age</span>
        </div>
        <ul>
          {items.map((r) => (
            <li key={r.label} className={cx("border-b border-line last:border-b-0", r.label === selected ? "bg-lilac" : "odd:bg-sand/60")}>
              <A href={href(tab, r.label)} aria-current={r.label === selected ? "true" : undefined} className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 no-underline sm:grid-cols-[5rem_minmax(0,1.6fr)_minmax(0,1fr)_4rem_minmax(0,1fr)_3rem]">
                <span className="font-semibold">{r.label}</span>
                <span className="order-6 text-right text-small sm:order-6">{ageText(iso(r.createdAt), now)}</span>
                <span className="order-2 col-span-2 text-small [overflow-wrap:anywhere] sm:order-2 sm:col-span-1">{r.displayName ?? "Unknown company"}{r.jobTitle ? ` · ${r.jobTitle}` : ""}</span>
                <span className="order-3 text-small">{reasonText(r.reason)}</span>
                <span className="order-4 text-small" title="Reports on this job, and on this company">{count(r.jobReports)} / {count(r.companyReports)}</span>
                <span className="order-5"><Pill tone={TONE[stateText(r)] ?? "neutral"} className="min-h-[30px]">{stateText(r)}</Pill></span>
              </A>
            </li>
          ))}
        </ul>
      </div>
      {(next || prev) && <Pager prevHref={prev} nextHref={next} />}
    </div>
  );
}

const Head = ({ label, title, pill }: { label: string; title: string; pill: string }) => (
  <header className="flex flex-wrap items-start justify-between gap-2">
    <h2 className="text-[22px] [overflow-wrap:anywhere]">{label} &middot; {title}</h2>
    <Pill tone="peach" className="min-h-[30px]">{pill}</Pill>
  </header>
);
const Text = ({ title, children }: { title: string; children: string }) => (
  <div><h3 className="mb-1 text-body font-semibold">{title}</h3><p className="whitespace-pre-line text-small [overflow-wrap:anywhere]">{children}</p></div>
);

/** The stored evidence file, opened through its route. */
const FileLine = ({ url }: { url: string }) => <div className="flex flex-wrap items-center gap-3"><span className="text-small font-semibold">Evidence file</span><OpenCopy url={url} name="evidence file" /><span className="text-small text-muted">Opening it is written to the audit log.</span></div>;

/** One report: what was said, the file, and the three steps (hide the job, clear, uphold which opens a case). The reporter is named here to staff only, never in a list or a notice. */
export function ReportPanel({ r, label, here, now }: { r: ReportItem; label: string; here: string; now: Date }) {
  const live = r.status === "open" || r.status === "job_hidden";
  const who = r.reporterCandidateUserId !== null ? "a candidate" : r.reporterPortalUserId !== null ? "a company login" : null;
  return (
    <section className="flex flex-col gap-4 rounded-card bg-sand p-5 sm:p-6 lg:rounded-bento" aria-label={`Report ${label}`}>
      <Head label={label} title={r.jobTitle ?? r.displayName ?? "Report"} pill={reasonText(r.reason)} />
      <p className="text-small text-muted [overflow-wrap:anywhere]">
        {r.displayName ?? "Unknown company"} &middot; {r.targetJobId ? "job report" : "company report"} &middot; {when(r.createdText)} &middot; {ageText(r.createdText, now)} ago
        {r.organisationId && <> &middot; <A href={`/companies/${r.organisationId}`} className="font-semibold text-deep-green underline">Company page</A></>}
      </p>
      <p className="text-small text-muted">{who ? `Reported by ${who}. The reporter is shown on this page only, until the report is closed.` : "The reporter was cleared when the report closed."}</p>
      {r.evidenceText ? <Text title="Evidence">{r.evidenceText}</Text> : <p className="text-small text-muted">No evidence text.</p>}
      {r.evidenceFile
        ? <FileLine url={`/api/trust-safety/evidence?reportId=${r.id}`} />
        : live && <Evidence query={`reportId=${r.id}`} here={here} />}
      <ul className="divide-y divide-line border-y border-line">
        <CheckRow ok title="Report opened">{when(r.createdText)}</CheckRow>
        {r.targetJobId && <CheckRow ok={r.status === "job_hidden" ? true : null} title="Job hidden">{r.status === "job_hidden" ? `Hidden while this is looked at (job is ${r.jobStatus ?? "hidden"})` : "Not hidden"}</CheckRow>}
        <CheckRow ok={live ? false : true} title="Decision">{live ? "Waiting for a decision" : `${stateText({ kind: "report", state: r.status })}${r.decidedAt ? ` on ${when(iso(r.decidedAt))}` : ""}`}</CheckRow>
      </ul>
      {r.caseId && <p className="text-small">A case was opened: <A href={href("open", `C-${r.caseId.padStart(4, "0")}`)} className="font-semibold text-deep-green underline">C-{r.caseId.padStart(4, "0")}</A></p>}
      {live && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            {r.targetJobId && r.status === "open" && <Act url={REPORTS} fixed={{ action: "hide", reportId: r.id }} label="Hide the job" variant="outline" here={here} confirm="The job is hidden from search now. It comes back if the report is cleared." />}
            <Act url={REPORTS} fixed={{ action: "clear", reportId: r.id }} label="Clear the report" variant="outline" here={here} confirm="No action: the report is closed and a hidden job comes back." />
          </div>
          <details className="rounded-card border border-line bg-white p-4">
            <summary className="cursor-pointer font-semibold">Uphold the report and open a case</summary>
            <div className="mt-3 flex flex-col gap-5">
              {([["false_claim", "false_sponsorship"], ["false_pay_floor", "false_pay_floor"]] as const).map(([caseKind, reasonCode]) => (
                <Act key={caseKind} url={REPORTS} fixed={{ action: "uphold", reportId: r.id, caseKind, reasonCode }} fields={[{ name: "noticeSummary", label: "What the employer is told (optional)", kind: "textarea", maxLength: 1000, optional: true }]}
                  label={`Open a case: ${reasonText(reasonCode).toLowerCase()}`} here={here} confirm="The report is upheld and a case is opened. Nothing is sent to the employer until you notify them from the case." />
              ))}
              <Act url={REPORTS} fixed={{ action: "uphold", reportId: r.id, caseKind: "instant_ban" }}
                fields={[{ name: "reasonCode", label: "Reason", kind: "select", options: [["asks_for_money", "Asks for money"], ["fake_company", "Fake company"], ["fake_job", "Fake job"]] }, { name: "noticeSummary", label: "What the employer is told (optional)", kind: "textarea", maxLength: 1000, optional: true }]}
                label="Open an instant-ban case" variant="danger" here={here} confirm="The company's live jobs are hidden and a verified company is suspended now. The ban itself waits for your decision and a second officer." />
            </div>
          </details>
        </div>
      )}
    </section>
  );
}

/** One case: the five steps, what each side wrote, the notes, and only the steps the case allows now (the database refuses the rest and says why). */
export function CasePanel({ c, label, reportLabel, meId, here, now }: { c: CaseItem; label: string; reportLabel?: string; meId: string; here: string; now: Date }) {
  const open = c.outcome === null, notified = c.replyDueAt !== null;
  const waiting = c.pending.length > 0, canConfirm = c.pending.some((p) => p.proposedBy !== meId);
  const appealOpen = c.appealDueAt !== null && c.appealedAt === null && c.appealDecidedAt === null;
  const appealWaits = c.appealedAt !== null && c.appealDecidedAt === null;
  const fix = (action: string, more: object = {}) => ({ action, caseId: c.id, ...more });
  return (
    <section className="flex flex-col gap-4 rounded-card bg-sand p-5 sm:p-6 lg:rounded-bento" aria-label={`Case ${label}`}>
      <Head label={label} title={c.displayName} pill={kindText(c.caseKind)} />
      <p className="text-small text-muted [overflow-wrap:anywhere]">
        {reasonText(c.reasonCode)} &middot; {outcomeText(c.outcome, c.level)} &middot; company is {c.organisationStatus.replace(/_/g, " ")} &middot; {ageText(iso(c.createdAt), now)} old &middot; <A href={`/companies/${c.organisationId}`} className="font-semibold text-deep-green underline">Company page</A>
        {reportLabel && <> &middot; <A href={href("open", reportLabel)} className="font-semibold text-deep-green underline">Report {reportLabel}</A></>}
      </p>
      {c.noticeSummary && <Text title="What the employer was told">{c.noticeSummary}</Text>}
      <ol aria-label="Where the case is" className="grid grid-cols-5 gap-2">
        {timeline(c, now).map((s, i, all) => (
          <li key={s.title} aria-current={s.ok === false ? "step" : undefined} className="relative flex min-w-0 flex-col gap-1.5">
            {i < all.length - 1 && <span aria-hidden="true" className={cx("absolute left-8 right-0 top-[15px] h-0.5", s.ok === true ? "bg-deep-green" : "bg-line")} />}
            <span aria-hidden="true" className={cx("relative grid size-8 place-items-center rounded-pill text-small font-semibold", s.ok === null ? "bg-lilac text-ink" : "bg-deep-green text-white", s.ok === false && "border-2 border-ink")}>{s.ok === true ? <Icon name="check" size={16} /> : i + 1}</span>
            <span className="text-caption font-semibold leading-tight">{s.title}<span className="sr-only">{s.ok === true ? ", done" : s.ok === false ? ", now" : ", not reached"}</span></span>
            {s.note && <span className="text-caption text-muted [overflow-wrap:anywhere]">{s.note}</span>}
          </li>
        ))}
      </ol>
      {c.employerReply && <Text title={`The employer's reply${c.replyReceivedAt ? `, received ${when(iso(c.replyReceivedAt))}` : ""}`}>{c.employerReply}</Text>}
      {c.appealText && <Text title={`The appeal${c.appealedAt ? `, received ${when(iso(c.appealedAt))}` : ""}`}>{c.appealText}</Text>}
      {c.wrcReported && <Notice kind="success">Reported to the WRC.</Notice>}
      {c.evidenceFile
        ? <FileLine url={`/api/trust-safety/evidence?caseId=${c.id}`} />
        : (open || appealWaits || appealOpen) && <Evidence query={`caseId=${c.id}`} here={here} />}

      {waiting && (
        <Notice kind="info" title="Waiting for a second officer">
          {c.pending.map((p) => PENDING_KIND[p.kind] ?? "Change").join(", ")}. {canConfirm ? "You did not propose this, so you can confirm or refuse it." : "You proposed this, so another officer confirms it. You can withdraw it."}
        </Notice>
      )}
      <div className="flex flex-wrap gap-2">
        {waiting && canConfirm && <Act url={CASES} fixed={fix("confirm")} label="Confirm" here={here} confirm="Confirm the proposed change? It takes effect now." />}
        {waiting && <Act url={CASES} fixed={fix("refuse")} label={canConfirm ? "Refuse" : "Withdraw"} variant="outline" here={here} confirm="The proposed change is dropped. Nothing else changes." />}
        {open && !notified && <Act url={CASES} fixed={fix("notify")} label="Notify the employer" here={here} confirm="The employer gets the notice by email and has 7 days to reply." />}
        {open && !waiting && <Act url={CASES} fixed={fix("decide", { outcome: "cleared" })} label="No action" variant="outline" here={here} confirm="The case is closed with no action. A suspended company and its hidden jobs come back." />}
        {open && !waiting && c.caseKind !== "instant_ban" && <Act url={CASES} fixed={fix("decide", { outcome: "strike" })} label="Apply strike" variant="danger" here={here} confirm="Strike 1 applies now. Strike 2 and 3 wait for a second officer. The employer is told by email." />}
        {c.bans.length > 0 && !waiting && c.banLiftedAt === null && <Act url={CASES} fixed={fix("propose_ban_lift")} label="Propose lifting the ban" variant="outline" here={here} confirm="A second officer has to confirm before the ban is lifted." />}
        {appealWaits && <Act url={CASES} fixed={fix("decide_appeal", { result: "upheld" })} label="Appeal: keep the decision" variant="outline" here={here} confirm="The decision stands. The employer is told by email." />}
        {appealWaits && <Act url={CASES} fixed={fix("decide_appeal", { result: "overturned" })} label="Appeal: overturn" variant="danger" here={here} confirm="The decision is overturned. A ban needs a second officer to lift it. The employer is told by email." />}
        {c.organisationKind === "agency" && c.caseKind === "instant_ban" && !c.wrcReported && <Act url={CASES} fixed={fix("mark_wrc")} label="Mark as reported to the WRC" variant="outline" here={here} confirm="Tick this off once the report to the WRC is made. It is written to the audit log." />}
      </div>
      {open && !waiting && c.caseKind === "instant_ban" && (
        <div className="rounded-card bg-error-tint p-4"><Act url={CASES} fixed={fix("decide", { outcome: "ban" })} fields={[{ name: "conclusive", label: "Conclusive evidence", help: "For written requests for money you may apply the ban before the 7 days are over. The 7 days then become the appeal window.", kind: "check" }]}
          label="Propose the ban" variant="danger" here={here} confirm="A ban waits for a second officer. On confirming, the company's CRO number and email domains are banned." /></div>
      )}
      {open && notified && !waiting && <Act url={CASES} fixed={fix("record_reply")} fields={[{ name: "text", label: "The employer's reply (by email or post)", kind: "textarea", maxLength: 5000, required: true }, { name: "receivedAt", label: "Received on", kind: "datetime" }]} label="Record the reply" variant="outline" here={here} />}
      {appealOpen && <Act url={CASES} fixed={fix("record_appeal")} fields={[{ name: "text", label: "The appeal (by email or post)", kind: "textarea", maxLength: 5000, required: true }, { name: "receivedAt", label: "Received on", kind: "datetime" }]} label="Record the appeal" variant="outline" here={here} />}

      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <h3 className="text-body font-semibold">Notes</h3>
        <p className="text-small text-muted">Staff only. A note is never sent to anyone and is kept with the case.</p>
        {c.notes.length === 0 ? <p className="text-small text-muted">No notes yet.</p> : (
          <ul className="flex flex-col gap-2">{c.notes.map((n) => (
            <li key={n.id} className="rounded-card bg-white p-3 text-small"><p className="whitespace-pre-line [overflow-wrap:anywhere]">{n.text}</p><p className="mt-1 text-muted">{n.staffName} &middot; {when(iso(n.createdAt))}</p></li>
          ))}</ul>
        )}
        <Act url={CASES} fixed={fix("add_note")} fields={[{ name: "text", label: "Add a note", kind: "textarea", maxLength: 5000, required: true }]} label="Add note" variant="outline" here={here} />
      </div>
    </section>
  );
}

export type Selected = { kind: "report"; item: ReportItem; label: string } | { kind: "case"; item: CaseItem; label: string; reportLabel?: string };

/** The whole page body for a trust and safety officer. `selected` is the item whose panel shows (null: none, or the id given is not one). */
export function Reports({ tab, items, counts, selected, missingId, meId, now, next, prev }: { tab: Tab; items: Row[]; counts: Counts | null; selected: Selected | null; missingId?: boolean; meId: string; now: Date; next?: string; prev?: string }) {
  const here = href(tab, selected?.label);
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="mb-1 text-[32px] leading-tight md:text-[34px]">Reports and strikes</h1>
        <p className="text-muted">A single complaint never triggers action on its own. Proof is seen by an officer; the employer has 7 days to reply; one appeal.</p>
      </header>
      <CountTabs label="Report tabs" items={TABS.map(([k, label]) => ({ label, count: counts ? count(counts[k]) : "", href: href(k), active: k === tab }))} />
      {missingId && <Notice kind="warning">That report or case was not found. Pick one from the list.</Notice>}
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_28rem]">
        <List tab={tab} items={items} selected={selected?.label} now={now} next={next} prev={prev} />
        {selected?.kind === "report" && <ReportPanel r={selected.item} label={selected.label} here={here} now={now} />}
        {selected?.kind === "case" && <CasePanel c={selected.item} label={selected.label} reportLabel={selected.reportLabel} meId={meId} here={here} now={now} />}
      </div>
    </div>
  );
}
