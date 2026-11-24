// The words for every answer the review routes give (docs/openapi/admin.yaml: /api/account-review, /api/fetched-jobs, /api/fetched-jobs/dry-run). A code with no entry
// still gets a plain sentence, never the code itself. `stage` is the rules stage that failed, for rules_failed.
const WORDS: Record<string, string> = {
  no_session: "Your session has ended. Sign in again.",
  not_active: "Your session has ended. Sign in again.",
  not_active_staff: "Your login is disabled, so nothing was saved.",
  not_reviewer: "Your roles do not let you do this.",
  not_found: "This item is no longer in the queue. Go back to the list.",
  already_decided: "Someone has already decided this item. Go back to the list.",
  not_claimed: "Claim this item first, then decide.",
  not_claimer: "Another reviewer holds this item, so only they can decide it.",
  claimed_by_other: "Another reviewer holds this item. A claim can be taken over after 24 hours, or when its holder is no longer active.",
  organisation_not_pending: "This company is no longer waiting for a decision.",
  has_permit_history: "This company has DETE permit history, so it cannot be approved as a first-time sponsor. Reject it, or ask for more.",
  free_email_domain: "That is a free email provider, so it cannot be saved as the company's domain. Untick \"Add the email domain\" and try again.",
  domain_owned_by_other: "Another company already holds that email domain. Untick \"Add the email domain\" and try again.",
  bad_domain: "That email domain cannot be saved for the company. Untick \"Add the email domain\" and try again.",
  no_claimant: "This company has no active owner to approve.",
  claimant_not_active: "The company's owner is blocked, deleted or banned, so the company cannot be approved. Reject it.",
  bad_question: "The question must be 1 to 1,000 characters, with no control characters.",
  job_not_in_review: "This job is no longer waiting for review.",
  no_advert_text: "The advert text was not saved, so the rules cannot be checked. Reject the item.",
  bad_occupation_code: "That occupation code is not on the Critical Skills list. Pick one from the list.",
  bad_salary: "The pay must be whole euro, up to 1,000,000, with the top not below the bottom.",
  bad_input: "Check the form and try again.",
  bad_stage: "That category does not exist.",
  bad_tab: "That tab does not exist.",
  bad_cursor: "That page link is not valid. Go back to the first page.",
  bad_origin: "The request did not come from this site. Reload the page and try again.",
  bad_body: "The request was not valid. Reload the page and try again.",
  bad_action: "The request was not valid. Reload the page and try again.",
  bad_item_id: "The request was not valid. Reload the page and try again.",
  bad_reason: "Pick a reason, then try again.",
  server_error: "Something went wrong on our side. Nothing was saved. Try again in a minute.",
};

export function errorWords(code: string, status: number, stage?: string): string {
  if (status === 0) return "Could not reach the server. Check your connection. Nothing was saved.";
  if (code === "rules_failed") return `The rules would not publish this job (stopped at: ${stage ?? "unknown stage"}). Check the code, the pay and the contract, or reject it.`;
  if (status === 429) return "Too many requests. Wait a minute and try again.";
  return WORDS[code] ?? (status >= 500 ? WORDS.server_error! : "That did not work. Reload the page and try again.");
}
