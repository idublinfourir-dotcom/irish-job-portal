// What the employer's permit services pages show (frames E17 and A08), worked out from the reads (readCases, readCase, readCaseTimeline, readCaseDocuments). Pure: no staff name, id or
// note ever reaches it (the routes never send one). Copied from the candidate's case pages (apps/candidate/app/account/cases/model.ts) with the employer's wording: the portal's case
// has no payer, employer or documents-needed field (B53), so what we asked for comes from the newest documents_needed step of the timeline.
export type CaseRow = {
  id: string; status: string; decisionOutcome: "granted" | "refused" | null; permitType: string; jobId: string | null; jobTitle: string | null;
  createdAt: string; lastChangeAt: string; documentCount: number;
};
export type CaseEvent = {
  at: string; kind: string; status: string; documentsNeeded?: { code: string; label: string | null }[]; outcome?: { code: string; label: string | null }; referral?: { code: string; firm?: string };
};
export type CaseDoc = { id: string; fileName: string | null; contentType: string; sizeBytes: number; uploadedAt: string; copyDeleted: boolean };
export type Ask = { code: string; label: string | null };

/** Who may ask for permit services and read the company's cases (the routes check it again). */
export const SERVICE_ROLES = ["account_owner", "recruiter"];
export const MAX_OPEN_CASES = 5; // CASE_LIMIT in the request route
export const STATUS_LABEL: Record<string, string> = {
  received: "Received", documents_needed: "Documents needed", waiting_for_employer: "Waiting on you", submitted: "Submitted", decision: "Decision", closed: "Closed",
};
export const PERMIT_LABEL: Record<string, string> = { critical_skills: "Critical Skills Employment Permit", general: "General Employment Permit" };
export const permitLabel = (t: string) => PERMIT_LABEL[t] ?? "Employment permit";
/** Who pays DETE's permit fee, by permit type (#297; the same two strings as the candidate site's permitFeeLabel). Not our service fee. */
export const permitFeeLabel = (permitType: string) => (permitType === "critical_skills" ? "Paid by the employee or employer" : "Usually paid by the employer");
/** Our service fee (#3, #84): the employer or agency pays it, never the candidate. */
export const SERVICE_FEE = "Our service fee is paid by the employer or agency, never the candidate.";

/** "4 Nov 2026", in Irish time. */
export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-IE", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Dublin" });
export const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export type CaseState = "open" | "granted" | "refused" | "closed" | "referred" | "withdrawn";
/** DD1: where the case stands. A closed case with no outcome is withdrawn (the timeline says so), referred (a referred step) or plainly closed. */
export function caseState(c: Pick<CaseRow, "status" | "decisionOutcome">, events: CaseEvent[]): CaseState {
  if (c.decisionOutcome) return c.decisionOutcome;
  if (c.status !== "closed") return "open";
  if (events.some((e) => e.kind === "withdrawn")) return "withdrawn";
  return events.some((e) => e.kind === "referred") ? "referred" : "closed";
}
export const isOpen = (c: Pick<CaseRow, "status" | "decisionOutcome">) => c.status !== "closed" && !c.decisionOutcome;
/** The route's own rule: no copies once the case is at decision or closed. */
export const canUpload = (c: Pick<CaseRow, "status" | "decisionOutcome">) => c.status !== "decision" && isOpen(c);
/** The documents we asked for: the newest documents_needed step, only while the case is waiting on them. */
export const asked = (c: CaseRow, events: CaseEvent[]): Ask[] => (c.status === "documents_needed" && isOpen(c) ? ([...events].reverse().find((e) => e.kind === "documents_needed")?.documentsNeeded ?? []) : []);

const STEPS = ["Received", "Documents needed", "Submitted", "Decision"] as const;
const AT: Record<string, number> = { received: 1, documents_needed: 2, waiting_for_employer: 2, submitted: 3, decision: 4 };
/** The furthest of the four steps reached (1 to 4), also for a closed case (the furthest step its timeline shows). */
export function reached(c: CaseRow, events: CaseEvent[]): number {
  if (c.decisionOutcome) return 4;
  return Math.max(1, AT[c.status] ?? 0, ...events.map((e) => AT[e.status] ?? 0));
}
export type Step = { label: string; detail: string; state: "done" | "now" | "todo" };
export function steps(c: CaseRow, events: CaseEvent[]): Step[] {
  const at = reached(c, events), live = isOpen(c), firstAt = events.find((e) => e.kind === "received")?.at ?? c.createdAt, n = asked(c, events).length;
  const detail = [
    fmtDate(firstAt),
    c.status === "waiting_for_employer" ? "Waiting on you" : c.documentCount > 0 ? `${c.documentCount} uploaded` : n ? `${n} needed` : live ? "Our checklist" : "",
    "Sent to DETE",
    c.decisionOutcome ? (c.decisionOutcome === "granted" ? "Granted" : "Refused") : "By email",
  ];
  return STEPS.map((label, i) => ({ label, detail: detail[i]!, state: i + 1 < at || (i + 1 === at && !live) ? "done" : i + 1 === at ? "now" : "todo" }));
}

/** The headline of the dark card and the words under it, per state (DD1). */
export function banner(c: CaseRow, state: CaseState, n: number): { title: string; lead: string | null; action: string | null } {
  switch (state) {
    case "granted": return { title: "Permit granted", lead: "A decision was made on this case: granted. We also tell you by email.", action: null };
    case "refused": return { title: "Permit refused", lead: "A decision was made on this case: refused. The Help page explains what you can do next.", action: null };
    case "referred": return { title: "Referred to a solicitor", lead: "Our team referred this case to a solicitor. Check your email for what happens next.", action: null };
    case "withdrawn": return { title: "Request withdrawn", lead: "This request was withdrawn. Nothing more will happen on it.", action: null };
    case "closed": return { title: "Case closed", lead: "This case is closed. No more documents can be added.", action: null };
    default:
  }
  switch (c.status) {
    case "documents_needed": return { title: "Documents needed", lead: null, action: n ? "Action needed from you" : null };
    case "waiting_for_employer": return { title: "Waiting on you", lead: "Our team asked for more details. We email you when something changes.", action: null };
    case "submitted": return { title: "Submitted", lead: "The application was sent to DETE. We email you when a decision is made.", action: null };
    case "decision": return { title: "Waiting for a decision", lead: "The application is with DETE for a decision. We email you when it is made.", action: null };
    default: return { title: "We have your request", lead: "Our team has your request. We aim to come back to you within 1 working day.", action: null };
  }
}

/** One line of the Updates card (newest first on the page). Never staff words: only the kind, the status, the codes' labels and the outcome. */
export function updateLine(e: CaseEvent): string {
  switch (e.kind) {
    case "received": return "Request received";
    case "assigned": return "Our team took the case";
    case "documents_needed": {
      const labels = (e.documentsNeeded ?? []).map((d) => d.label ?? "Another document");
      return labels.length ? `We asked you for: ${labels.join(", ")}` : "We asked you for documents";
    }
    case "decision": return `A decision was made${e.outcome ? `: ${e.outcome.label ?? e.outcome.code}` : ""}`;
    case "closed": return "The case was closed";
    case "referred": return "Our team referred the case to a solicitor";
    case "withdrawn": return "The request was withdrawn";
    default: return `The case moved to: ${STATUS_LABEL[e.status] ?? "a new step"}`;
  }
}
/** The card shows the job only (#287, L7): the title, or a plain name when the request is about no job. */
export const caseTitle = (c: Pick<CaseRow, "jobTitle">) => c.jobTitle ?? "Permit request";
export const caseSubtitle = (c: CaseRow) => [permitLabel(c.permitType), `Case ${c.id}`].join(" · ");
