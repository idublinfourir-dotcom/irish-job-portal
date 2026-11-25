// The words for every answer of the contact, employer job, pay floor, account, company and seed routes (docs/openapi/admin.yaml). It adds to messages.ts and,
// where a company page needs other words than the account review card, replaces them. A code with no entry still gets a plain sentence (errorWords).
import { errorWords } from "./messages";

const NOT_YOURS = "Your roles do not let you do this.";
const WORDS: Record<string, string> = {
  not_contact_reader: NOT_YOURS, not_contact_staff: "Only a services case handler or a content editor can act on a message. An administrator can read.",
  not_floor_staff: NOT_YOURS, not_rules_editor: "Only a rules data editor can propose a floor.", not_rules_data_editor: "Only a rules data editor can do this.",
  not_domain_staff: NOT_YOURS, not_limit_staff: NOT_YOURS, not_account_reviewer: "Only an account reviewer can do this.", not_seed_staff: NOT_YOURS,
  not_dete_link_viewer: NOT_YOURS, not_dete_link_staff: "Only an account reviewer can link a DETE name.", bad_name: "That DETE name is not valid. Reload the page.", bad_page: "That page does not exist. Go back to the first page.",
  bad_input: "The request was not valid. Reload the page and try again.", name_not_found: "That DETE name is not in the permit data any more. Reload the page.",
  not_linked: "That DETE name is not linked to a company, so there is nothing to unlink.", linked_elsewhere: "That DETE name is already linked to another company.", name_taken: "That name already belongs to another company.",
  not_administrator: "Only an administrator can do this.",
  bad_query: "That page address is not valid. Go back to the list.", bad_queue: "That queue does not exist.",
  bad_message_id: "The request was not valid. Reload the page and try again.", bad_floor_id: "The request was not valid. Reload the page and try again.",
  bad_user_id: "That is not a login id. Copy it again from where you found it.", bad_request_id: "The request was not valid. Reload the page and try again.",
  bad_organisation_id: "The request was not valid. Reload the page and try again.", bad_limit: "The member limit must be a whole number from 1 to 50.",
  bad_text: "The file must be 1 to 1,000,000 characters.", bad_data: "The file was refused, so nothing was proposed.",
  not_claimed: "Claim this item first, then decide.",
  floor_not_pending: "This floor is no longer waiting for a check. Go back to the list.", floor_expired: "This floor has run out, so it cannot be confirmed. Reject it.",
  not_big_company: "This company is no longer on the big-company list, so its floor cannot be confirmed. Reject it.",
  organisation_not_active: "This company is not active, so its floor cannot be confirmed.", company_not_active: "This company is not active, so the job cannot be approved. Reject it.",
  decision_pending: "A proposal for this is already waiting for a second administrator.", nothing_pending: "No proposal is waiting, so there is nothing to confirm. Propose it first.",
  same_person: "A different administrator has to do this step. You made the proposal. You can only withdraw it.",
  reauth_required: "For safety, sign in again to do this.",
  same_account: "Keep and drop must be two different logins.", already_held: "That login is already suspended or blocked.", not_held: "That login is not suspended or blocked, so there is nothing to lift.",
  request_not_pending: "That request is no longer waiting. Reload the page.", kept_account_deleted: "The account to keep was deleted, so nothing can be merged into it.",
  open_services_case: "One of the two accounts has an open services case. Close it first. The merge is still waiting.",
  open_report: "One of the two accounts has an open report. Close it first. The merge is still waiting.",
  domain_owned_by_other: "Another company already holds that email domain.", free_email_domain: "That is a free email provider, so it cannot be a company domain.",
  bad_domain: "That is not a domain name this company can have. Write it like company.example.", already_added: "The company already has that domain.",
  company_merged: "This company was merged into another one. Open the other company.", open_ban_case: "An open case would ban this domain, so it stays until the case is closed.",
  domain_not_found: "The company does not have that domain. Reload the page.",
  below_active: "The limit cannot be lower than the number of active members.",
  not_checked: "Tick both checks before you record the request.", member_not_found: "No member has that id. Check the id.",
  already_owner: "That member is already the owner.", company_not_open: "This company is not open, so its owner cannot change.", no_owner: "This company has no owner on record.",
  user_not_active: "That member's login is not active, so they cannot become the owner.", request_open: "This company already has an open owner request.",
  not_open: "That request is no longer open. Reload the page.", too_early: "The 7 days have not passed yet.", owner_changed: "The owner changed since the request. Cancel it and record a new one.",
  member_gone: "That member left the company. Cancel the request.",
  scan_pending: "The copy is still being checked. Try again in a few minutes.", file_blocked: "The check found a problem, so the copy cannot be opened.",
  files_unavailable: "Files cannot be opened right now. Try again in a few minutes.",
};

/** The words for a route's error code; `stage` carries the first lines of a refused seed file. */
export function staffWords(code: string, status: number, stage?: string): string {
  if (code === "bad_data" && status !== 0) return `${WORDS.bad_data} ${stage ?? ""}`.trim();
  return (status !== 0 && WORDS[code]) || errorWords(code, status, stage);
}
