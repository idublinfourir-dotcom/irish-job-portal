// Words and small checks for the reports and strikes page (frame D08) and the ban list (D09). Pure: no database, no network. Placeholder wording, as the other staff pages.
import { parse, when } from "../_queue/age";

export const TABS = [["open", "Open"], ["waiting", "Waiting for employer reply"], ["appeals", "Appeals"], ["closed", "Closed"]] as const;
export type Tab = (typeof TABS)[number][0];
export const isTab = (v: string | undefined): v is Tab => TABS.some(([k]) => k === v);

/** One row of the list (GET /api/trust-safety/list). The label is the one id: R for a report, C for a case. */
export type Row = {
  kind: "report" | "case"; id: string; label: string; createdAt: string | Date; organisationId: string | null; displayName: string | null; organisationKind: string | null;
  jobId: string | null; jobTitle: string | null; reason: string; state: string; outcome: string | null; level: number | null; reportId: string | null; jobReports: number; companyReports: number;
};
export type Counts = Record<Tab, number>;
/** A report read on its own (getReport). The reporter is a login id for staff on this page only: the page shows that there is one and which kind, never the id. */
export type ReportItem = {
  id: string; status: string; targetKind: string; reason: string; createdText: string; targetJobId: string | null; jobTitle: string | null; jobStatus: string | null; organisationId: string | null;
  displayName: string | null; evidenceText: string | null; reporterCandidateUserId: string | null; reporterPortalUserId: string | null; decidedAt: string | Date | null; evidenceFile: boolean; caseId: string | null;
};
export type Pending = { id: string; kind: string; change: Record<string, unknown>; proposedBy: string };
export type Note = { id: string; text: string; staffName: string; createdAt: string };
export type CaseItem = {
  id: string; organisationId: string; caseKind: string; jobId: string | null; reportId: string | null; reasonCode: string; noticeSummary: string | null; level: number | null; stage: string; outcome: string | null;
  replyDueAt: string | Date | null; employerReply: string | null; replyReceivedAt: string | Date | null; decidedAt: string | Date | null; appealDueAt: string | Date | null; appealText: string | null;
  appealedAt: string | Date | null; appealDecidedAt: string | Date | null; banLiftedAt: string | Date | null; createdAt: string | Date; evidenceFile: boolean; displayName: string; organisationKind: string; organisationStatus: string;
  pending: Pending[]; bans: { id: string }[]; notes: Note[]; wrcReported: boolean;
};

/** A time from the database as an ISO text the age helpers read (a read gives a Date or Postgres text). */
export const iso = (v: string | Date | null | undefined): string => (v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : v);
export const isPast = (v: string | Date | null | undefined, now: Date): boolean => iso(v) !== "" && parse(iso(v)).getTime() < now.getTime();

/** "R-0091" or "C-0091" back into its kind and id; anything else is null (a hostile ?id= never reaches a read). */
export function parseLabel(v: string | undefined): { kind: "report" | "case"; id: string } | null {
  const m = v === undefined ? null : /^([RC])-(\d{4,18})$/.exec(v);
  return m ? { kind: m[1] === "R" ? "report" : "case", id: String(BigInt(m[2]!)) } : null;
}

export const href = (tab: Tab, label?: string, after?: string) =>
  `/reports${(s => (s ? `?${s}` : ""))(new URLSearchParams({ ...(tab === "open" ? {} : { tab }), ...(label ? { id: label } : {}), ...(after ? { after } : {}) }).toString())}`;

const REASON: Record<string, string> = {
  asks_for_money: "Asks for money", no_sponsorship: "Says no sponsorship", job_closed: "Job closed", wrong_details: "Wrong details", other: "Other", fake_company: "Fake company",
  fake_job: "Fake job", strike_3: "Strike 3", false_sponsorship: "False sponsorship claim", false_pay_floor: "False pay floor",
};
export const reasonText = (code: string) => REASON[code] ?? "Other";
export const CASE_KIND: Record<string, string> = { false_claim: "False claim", false_pay_floor: "False pay floor", instant_ban: "Instant-ban trigger" };
export const kindText = (k: string) => CASE_KIND[k] ?? "Case";

const REPORT_STATE: Record<string, string> = { open: "New", job_hidden: "Job hidden", cleared: "Cleared", upheld: "Upheld" };
const CASE_STATE: Record<string, string> = {
  case_open: "Case open", employer_notified: "Waiting for reply", reply_window: "Waiting for reply", decided: "Decided", applied: "Decided", appealed: "Appeal", upheld: "Appeal decided", overturned: "Appeal decided",
};
export const stateText = (r: Pick<Row, "kind" | "state">) => (r.kind === "report" ? REPORT_STATE : CASE_STATE)[r.state] ?? "Closed";
export const outcomeText = (o: string | null, level: number | null) => (o === "strike" ? `Strike${level ? ` ${level}` : ""}` : o === "ban" ? "Ban" : o === "cleared" ? "No action" : "Not decided yet");

export const PENDING_KIND: Record<string, string> = { strike_2: "Strike 2", strike_3: "Strike 3", ban: "Ban", ban_lift: "Ban lift" };

/** The five steps of a case (frame D08): what is done, which one is next. `ok`: true done, false the step now, null still to come. */
export function timeline(c: CaseItem, now: Date): { title: string; note: string; ok: boolean | null }[] {
  const notified = c.replyDueAt !== null, decided = c.outcome !== null, appealed = c.appealedAt !== null;
  const done = [true, notified, decided || (notified && (c.employerReply !== null || isPast(c.replyDueAt, now))), decided, c.appealDecidedAt !== null];
  const now1 = done.indexOf(false);
  return [
    ["Case opened", when(iso(c.createdAt))], ["Employer notified", notified ? "" : "Not yet notified"],
    ["Reply window", c.employerReply !== null ? "Reply recorded" : notified ? `Until ${when(iso(c.replyDueAt))}` : ""],
    ["Decision", decided ? outcomeText(c.outcome, c.level) : ""],
    ["Appeal", c.appealDecidedAt !== null ? (c.stage === "overturned" ? "Overturned" : "Upheld") : appealed ? "Waiting for a decision" : c.appealDueAt !== null ? `Open until ${when(iso(c.appealDueAt))}` : ""],
  ].map(([title, note], i) => ({ title: title!, note: note!, ok: done[i] ? true : i === now1 ? false : null }));
}
