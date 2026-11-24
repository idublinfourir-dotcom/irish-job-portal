// The sentence of an audit row on the overview ("Dara Kelly approved an account"). The action codes are the ones the database functions write; a code not listed here is
// shown as its own words (underscores and dots as spaces), never hidden. Pure.
const SENTENCE: Record<string, string> = {
  "account_review.approved": "approved an account",
  "account_review.needs_info": "asked a company for more information",
  "account_review.rejected": "rejected an account",
  "account_review.take_over": "took over an account review",
  "account_review.release": "released an account review",
  "fetched_job.approve": "approved a fetched job",
  "fetched_job.reject": "rejected a fetched job",
  "fetched_job.take_over": "took over a fetched job",
  "fetched_job.release": "released a fetched job",
  "trust_safety.report_hide": "hid a job after a report",
  "trust_safety.report_clear": "cleared a report",
  "trust_safety.report_uphold": "upheld a report",
  "trust_safety.case_open": "opened a strike case",
  "trust_safety.case_decide": "decided a strike case",
  "audit.export": "exported the audit log",
  "staff.export": "exported their own staff data",
  "organisation_domain.add": "added a company email domain",
  "data_request.close": "closed a data request",
};
export const auditSentence = (action: string): string => SENTENCE[action] ?? action.replace(/[._]+/g, " ");

const initial = (name: string | null) => (name ?? "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
export { initial as auditInitials };
