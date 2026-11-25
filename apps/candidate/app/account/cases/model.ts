// What the permit case pages show, worked out from the three reads (readCase, readCaseTimeline, readCaseDocuments). Pure: no staff name, id or note ever
// reaches it (the routes never send one), and the wording of every state is here, so a test holds each one.
export type CaseRow = {
  id: string; status: string; decisionOutcome: "granted" | "refused" | null; permitType: string; jobId: string | null; jobTitle: string | null; employerName: string | null;
  payer: "employer" | "agency" | null; documentsNeeded: { code: string; label: string | null }[]; createdAt: string; lastChangeAt: string; documentCount: number;
};
export type CaseEvent = {
  at: string; kind: string; status: string; documentsNeeded?: { code: string; label: string | null }[]; outcome?: { code: string; label: string | null }; referral?: { code: string; firm?: string };
};
export type CaseDoc = { id: string; fileName: string | null; contentType: string; sizeBytes: number; uploadedAt: string; copyDeleted: boolean };

export const MAX_OPEN_CASES = 5; // CASE_LIMIT in the request route
export const STATUS_LABEL: Record<string, string> = {
  received: "Received", documents_needed: "Documents needed", waiting_for_employer: "Waiting for your employer", submitted: "Submitted", decision: "Decision", closed: "Closed",
};
export const PERMIT_LABEL: Record<string, string> = { critical_skills: "Critical Skills Employment Permit", general: "General Employment Permit" };
export const permitLabel = (t: string) => PERMIT_LABEL[t] ?? "Employment permit";

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

const STEPS = ["Received", "Documents needed", "Submitted", "Decision"] as const;
const AT: Record<string, number> = { received: 1, documents_needed: 2, waiting_for_employer: 2, submitted: 3, decision: 4 };
/** The furthest of the four steps reached (1 to 4), also for a closed case (the furthest step its timeline shows). */
export function reached(c: CaseRow, events: CaseEvent[]): number {
  if (c.decisionOutcome) return 4;
  return Math.max(1, AT[c.status] ?? 0, ...events.map((e) => AT[e.status] ?? 0));
}
export type Step = { label: string; detail: string; state: "done" | "now" | "todo" };
export function steps(c: CaseRow, events: CaseEvent[]): Step[] {
  const at = reached(c, events), live = isOpen(c), firstAt = events.find((e) => e.kind === "received")?.at ?? c.createdAt;
  const detail = [
    fmtDate(firstAt),
    c.status === "waiting_for_employer" ? "Waiting for your employer" : c.documentCount > 0 ? `${c.documentCount} uploaded` : c.documentsNeeded.length ? `${c.documentsNeeded.length} needed` : live ? "Our checklist" : "",
    "Sent to DETE",
    c.decisionOutcome ? (c.decisionOutcome === "granted" ? "Granted" : "Refused") : "By email",
  ];
  return STEPS.map((label, i) => ({ label, detail: detail[i]!, state: i + 1 < at || (i + 1 === at && !live) ? "done" : i + 1 === at ? "now" : "todo" }));
}

/** The headline of the dark card and the words under it, per state (DD1). */
export function banner(c: CaseRow, state: CaseState): { title: string; lead: string | null; action: string | null } {
  switch (state) {
    case "granted": return { title: "Permit granted", lead: "A decision was made on this case: granted. We also tell you by email.", action: null };
    case "refused": return { title: "Permit refused", lead: "A decision was made on this case: refused. The Help page explains what you can do next.", action: null };
    case "referred": return { title: "Referred to a solicitor", lead: "Our team referred your case to a solicitor. Check your email for what happens next.", action: null };
    case "withdrawn": return { title: "Request withdrawn", lead: "You withdrew this request. Nothing more will happen on it.", action: null };
    case "closed": return { title: "Case closed", lead: "This case is closed. No more documents can be added.", action: null };
    default:
  }
  switch (c.status) {
    case "documents_needed": return { title: "Documents needed", lead: null, action: c.documentsNeeded.length ? "Action needed from you" : null };
    case "waiting_for_employer": return { title: "Waiting for your employer", lead: "We asked your employer for details. We email you when something changes.", action: null };
    case "submitted": return { title: "Submitted", lead: "Your application was sent to DETE. We email you when a decision is made.", action: null };
    case "decision": return { title: "Waiting for a decision", lead: "Your application is with DETE for a decision. We email you when it is made.", action: null };
    default: return { title: "We have your request", lead: "Our team has your request. We aim to come back to you within 1 working day.", action: null };
  }
}

/** Who pays (B32), in the decided wording: our services are paid by the employer or agency, never the candidate (CF1 and CF4 stay open as questions, so no claim about the DETE fee). */
export function whoPays(payer: CaseRow["payer"]): string {
  if (payer === "employer") return "Our permit services for this application are paid by your employer, never by you.";
  if (payer === "agency") return "Our permit services for this application are paid by the agency, never by you.";
  return "Our permit services are free for candidates. The employer or agency pays for them, never you.";
}

/** One line of the Updates card (newest first on the page). Never staff words: only the kind, the status, the codes' labels and the outcome. */
export function updateLine(e: CaseEvent): string {
  switch (e.kind) {
    case "received": return "Request received";
    case "assigned": return "Our team took your case";
    case "documents_needed": {
      const labels = (e.documentsNeeded ?? []).map((d) => d.label ?? "Another document");
      return labels.length ? `We asked you for: ${labels.join(", ")}` : "We asked you for documents";
    }
    case "decision": return `A decision was made${e.outcome ? `: ${e.outcome.label ?? e.outcome.code}` : ""}`;
    case "closed": return "Your case was closed";
    case "referred": return "Our team referred your case to a solicitor";
    case "withdrawn": return "You withdrew this request";
    default: return `Your case moved to: ${STATUS_LABEL[e.status] ?? "a new step"}`;
  }
}
export const caseTitle = (c: Pick<CaseRow, "jobTitle">) => c.jobTitle ?? "Permit request";
export const caseSubtitle = (c: CaseRow) => [permitLabel(c.permitType), c.employerName, `Case ${c.id}`].filter(Boolean).join(" · ");
