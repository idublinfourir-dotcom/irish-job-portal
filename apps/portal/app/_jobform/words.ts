// The words of the posting form (frames NE3, E10): one sentence for every answer of the routes the form calls (docs/openapi/portal.yaml), and what a saved job says. Pure, so a unit test
// tries every status and code the yaml lists. `status` 0 is "no answer" (offline).
import type { Answer } from "../(auth)/messages";
import { common } from "../_jobs/words";
import { reasonWord } from "./model";

const SERVER = "This is not working right now. Try again in a few minutes.";

/** POST /api/portal/jobs and /jobs/edit (and /jobs/check, the same body): 200; 400 BAD_REQUEST, CLIENT_ONLY_FOR_AGENCIES, WRITTEN_AUTHORITY_REQUIRED; 401; 403; 404; 409; 413; 422 a rules code; 429. */
export function saveMessage(a: Answer): string {
  if (a.status === 400) {
    if (a.code === "CLIENT_ONLY_FOR_AGENCIES") return "Only a jobs agency can post for a client. Choose that the permit employer is your company.";
    if (a.code === "WRITTEN_AUTHORITY_REQUIRED") return "Tick that you have the client's written authority before you sign the statement for a client.";
    return "One of the fields is not valid. Check the title, the address (it starts with https://), the numbers and the length of the text.";
  }
  if (a.status === 403) {
    if (a.code === "NOT_A_SIGNER") return "You are not set up to sign the sponsorship statement. Ask the account owner to make you a signer in Team, or leave the statement for a signer.";
    if (a.code === "BADGE_RESTRICTED") return "Your company cannot show the Sponsor confirmed badge now. Post without signing the statement.";
  }
  if (a.status === 404) return "This job is not on your company's list any more. Open the jobs list and try again.";
  if (a.status === 409) {
    if (a.code === "NO_STATEMENT_TEXT") return "The sponsorship statement wording is not published yet, so a job cannot be signed now. Save it as a draft and come back.";
    if (a.code === "NEEDS_REVIEW") return "A person would have to check this first: the client's name is not in the permit records, or the change would put a live job into review. Check the client's name, or save a draft.";
    return "This job cannot be changed in its current state. Open the jobs list to see where it is.";
  }
  if (a.status === 422) return a.code === "STATEMENT_REQUIRED" ? "Confirm the sponsorship statement in step 5, then publish." : reasonWord(a.code) || "The rules did not accept this post. Check the fields and the live checks.";
  return common(a) ?? SERVER;
}

/** The states a save can end in; the jobs list and the edit page show a line for these only (nothing else in the address is trusted). */
export const SAVED = ["draft", "live", "in_review", "under_review"];

/** What a saved job says. `status` is the job's state after the save. */
export function savedWord(status: unknown, draft: boolean): string {
  if (draft || status === "draft") return "Draft saved. It is not shown to anyone yet.";
  if (status === "in_review") return "Saved. Our team checks the job before it goes live. You will see it in the In review tab.";
  if (status === "under_review") return "Saved, but the job is still under review. Open it in the list to see why.";
  return "Your job is live.";
}

/** The reads the form page starts from (GET /api/portal/jobs/form, /jobs/grades, /jobs/{id}, /jobs/suggest): a sentence for a read that failed. */
export function loadMessage(a: Answer): string {
  if (a.status === 404) return "This job is not on your company's list. Open the jobs list and try again.";
  if (a.status === 400) return "That request was not right. Reload the page and try again.";
  return common(a) ?? SERVER;
}

/** The written authority copies of an agency job (GET and POST /api/portal/jobs/{id}/authority, GET .../authority/{docId}). */
export function authorityMessage(a: Answer): string {
  if (a.status === 400) return a.code === "EMPTY_FILE" ? "That file is empty. Choose another." : "Choose one file to add.";
  if (a.status === 404) return a.code === "DOCUMENT_NOT_FOUND" ? "That copy is not stored any more." : "This job is not an agency job for a client, or you cannot post for it.";
  if (a.status === 409) return "This job already holds 20 copies. Nothing more can be added.";
  if (a.status === 413) return "That file is too big. The most is 4 MB.";
  if (a.status === 415) return "Add a PDF, a JPEG or a PNG. Other files, and damaged ones, are not accepted.";
  if (a.status === 422) return "That PDF holds active content or is locked, so it is not accepted. Save a plain copy and add that.";
  if (a.status === 503) return "File storage is not set up yet, so a copy cannot be added now. The tick on the statement is what the rules need.";
  return common(a) ?? SERVER;
}
