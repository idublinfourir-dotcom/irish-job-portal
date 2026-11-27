// What the permit services pages say when a route answers (docs/openapi/portal.yaml, paths /api/portal/cases...). Pure text; a test reads the codes from the yaml and holds each to
// its own sentence. The server's own message is never shown; an unknown code gets the general line of its status, never a blank.
export type Answer = { status: number; code?: string };

export const CODE_TEXT: Record<string, string> = {
  BAD_REQUEST: "Check what you typed and try again. If it keeps failing, reload the page.",
  NO_SESSION: "Your sign-in has ended. Sign in again to carry on.",
  BAD_ORIGIN: "The page could not confirm where the request came from. Reload the page and try again.",
  REFUSED: "This login cannot do that. If you think that is a mistake, use the contact form on the Help page.",
  ROLE_REFUSED: "Only the account owner and recruiters of a verified company can ask for permit services.",
  NOT_REQUESTER: "Only the person who asked for this case can withdraw it.",
  CASE_NOT_FOUND: "We could not find that case.",
  CASE_NOT_OPEN: "This case has already been decided or closed, so it cannot be withdrawn.",
  CASE_CLOSED: "This case has moved on to a decision, so it takes no more documents.",
  CASE_LIMIT: "You have 5 open cases, the most we can hold at once. Wait for one to finish, or withdraw one.",
  JOB_NOT_FOUND: "That job is no longer live on your company. Choose another job, or send the request without one.",
  SERVICES_UNAVAILABLE: "Permit services are not open yet. Please try again later.",
  DOCUMENT_LIMIT: "This case already holds 20 documents, the most we keep.",
  DOCUMENT_NOT_FOUND: "That copy is no longer kept, so it cannot be opened.",
  SCAN_PENDING: "This copy is still being checked for viruses. Try again in a minute.",
  FILE_BLOCKED: "This copy did not pass the virus check, so it cannot be opened. Upload a clean copy.",
  EMPTY_FILE: "That file is empty. Choose a PDF, JPG or PNG.",
  FILE_TOO_LARGE: "That file is too big. Use a file of 4 MB or less.",
  WRONG_FILE_TYPE: "Upload a PDF, JPG or PNG.",
  FILE_ACTIVE_CONTENT: "That file has content we cannot accept. Upload a plain PDF, JPG or PNG.",
  FILES_UNAVAILABLE: "Documents are not open yet. Please try again later.",
  BODY_TOO_LARGE: "The request was too large to send. Reload the page and try again.",
  TOO_MANY_REQUESTS: "Too many tries. Wait a few minutes, then try again.",
};
/** The message for one answer; status 0 is "no answer" (offline). */
export function say(r: Answer): string {
  if (r.status === 0) return "We could not reach the site. Check your connection and try again.";
  const by = CODE_TEXT[r.code ?? ""];
  if (by) return by;
  if (r.status === 429) return CODE_TEXT.TOO_MANY_REQUESTS!;
  if (r.status >= 500) return "Something went wrong on our side. Try again in a few minutes.";
  return "That did not work. Reload the page and try again.";
}
