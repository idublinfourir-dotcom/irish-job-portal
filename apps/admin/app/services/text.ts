// The words of the services board (frame D11): statuses, permit types, who pays, and a sentence for every answer the services routes give. Pure, so a test covers each.
// The facts come from the board reads (packages/db/src/services-board.ts, B73): the list holds no requester name, employer, handler name or days in status, so none is shown.
import { errorWords } from "../_queue/messages";

export const COPIES_NOTE = "Copies only, never originals.";
export const KEEP_NOTE = "Copies are deleted 30 days after a case closes.";
export const FEE_NOTE = "Our service fee is paid by the employer or agency.";
export const SCOPE_NOTE = "Scope: application support, not legal advice.";

export const STATUSES = ["received", "documents_needed", "waiting_for_employer", "submitted", "decision"] as const;
export type Status = (typeof STATUSES)[number];
export const isStatus = (v: string | undefined): v is Status => STATUSES.some((s) => s === v);
export const STATUS_LABEL: Record<string, string> = { received: "Received", documents_needed: "Documents needed", waiting_for_employer: "Waiting on employer", submitted: "Submitted", decision: "Decision", closed: "Closed" };
export const statusLabel = (s: string) => STATUS_LABEL[s] ?? s;

/** Allowed moves between open statuses: the same table the route checks (services-board.ts CASE_MOVES); the route stays the judge. */
export const MOVES: Record<string, readonly string[]> = {
  received: ["documents_needed", "waiting_for_employer", "submitted"],
  documents_needed: ["waiting_for_employer", "submitted"],
  waiting_for_employer: ["documents_needed", "submitted"],
  submitted: ["documents_needed", "decision"],
  decision: [],
};

export const permitLabel = (p: string | null) => (p === "critical_skills" ? "Critical Skills" : p === "general" ? "General" : "Permit not chosen");
export const payerLabel = (p: string | null) => (p === "employer" ? "Employer" : p === "agency" ? "Agency" : "Not set");
export const sideLabel = (s: string | null) => (s === "candidate" ? "Candidate" : s === "portal" ? "Employer or agency" : "Not known");
export const caseRef = (id: string) => `PS-${id.padStart(4, "0")}`;
export const OUTCOME_LABEL: Record<string, string> = { granted: "Permit granted", refused: "Permit refused" };
export const CLOSE_LABEL: Record<string, string> = { decided: "Decided", employer_not_engaged: "Employer did not engage", no_reply: "No reply", referred_to_solicitor: "Referred to a solicitor", withdrawn: "Withdrawn by the requester" };

/** The codes staff may ask for (the route's fixed list, admin.yaml actOnServicesCase: documents). Placeholder labels, as the database's list. */
export const DOC_CODES: readonly [string, string][] = [
  ["passport_copy", "Passport copy"], ["offer_letter", "Job offer letter"], ["contract", "Employment contract"], ["degree", "Degree or qualification"],
  ["registration", "Professional registration"], ["payslip", "Recent payslip"], ["cv", "CV"], ["other", "Other document"],
];

export type Row = { id: string; status: string; createdAt: string; permitType: string | null; payer: string | null; hrContactConsent: boolean; assignedStaffUserId: string | null; side: string | null };
export type Note = { id: string; authorStaffUserId: string; body: string; createdAt: string };
export type CaseItem = {
  id: string; status: string; createdAt: string; permitType: string | null; offerDetails: { details?: Record<string, string> } | null; payer: string | null; hrContactConsent: boolean;
  decisionOutcome: string | null; documentsNeeded: { code: string; label: string | null }[]; decidedAt: string | null; closedAt: string | null; closeReason: string | null;
  referralSolicitorId: string | null; assignedStaffUserId: string | null; side: string | null; requesterErased: boolean;
  requesterName?: string | null; requesterEmail?: string | null; copies?: number; notes?: Note[];
};
export type Doc = { id: string; fileName: string | null; contentType: string | null; sizeBytes: number | null; uploadedAt: string; copyDeleted: boolean; uploadedBy: string };

export const FROM_LABEL: Record<string, string> = { candidate: "Candidate", portal: "Employer or agency", staff: "Staff", gone: "Account removed" };

/** Who holds a case, from the viewer's side: the list gives an id only, never a name. */
export const holder = (assigned: string | null, me: string): "me" | "none" | "other" => (assigned === null ? "none" : assigned === me ? "me" : "other");

/** A refusal or failure of a services route, in plain words. Own sentences first, then the shared ones. */
const WORDS: Record<string, string> = {
  not_case_staff: "Your roles do not let you work on services cases.",
  not_case_handler: "Only the services case handler the case is assigned to can do this.",
  not_assigned: "This case is another handler's, so only they can do this.",
  own_case: "This case is under your own email address, so you cannot open or work on it.",
  case_not_found: "This case is not assigned to you, or it no longer exists.",
  case_closed: "This case is closed, so nothing more can be changed.",
  bad_move: "That status move is not allowed from where the case is now.",
  bad_assignee: "That person cannot take this case. They must be an active case handler and not the requester.",
  not_at_decision: "Record the outcome only once the case is at the decision stage.",
  not_decided: "Record the outcome first, then close the case as decided.",
  outcome_recorded: "An outcome is recorded, so the case can only close as decided.",
  bad_solicitor: "That firm is not on the active solicitor list. Pick another.",
  no_change: "Nothing to change: it is already so.",
  bad_codes: "Pick at least one document from the list.",
  bad_text: "A note must be 1 to 2,000 characters, with no control characters.",
  bad_case_id: "The request was not valid. Reload the page and try again.",
  bad_staff_id: "The request was not valid. Reload the page and try again.",
  bad_solicitor_id: "The request was not valid. Reload the page and try again.",
  bad_outcome: "The request was not valid. Reload the page and try again.",
  bad_query: "The request was not valid. Reload the page and try again.",
  bad_id: "The request was not valid. Reload the page and try again.",
  bad_status: "That status does not exist.",
  document_not_found: "That copy is no longer on this case.",
  scan_pending: "This copy is still being checked for viruses. Try again later.",
  file_blocked: "This copy failed the virus check, so it cannot be opened.",
  files_unavailable: "File storage is not available right now. Try again later.",
};
export const words = (code: string, status: number): string => WORDS[code] ?? errorWords(code, status);
