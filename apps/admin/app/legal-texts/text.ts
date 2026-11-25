// The words of the legal texts page, pure so a test covers them. The purposes are the route's own list (docs/openapi/admin.yaml, /api/legal-texts).
export const PURPOSES: readonly [string, string][] = [
  ["signup_terms", "Candidate sign-up terms"],
  ["portal_signup_terms", "Employer and agency sign-up terms"],
  ["privacy_notice", "Privacy notice"],
  ["cookie_policy", "Cookie policy"],
  ["employer_acceptable_use", "Employer acceptable use"],
  ["data_retention", "Data retention"],
];
export const MAX_BODY = 100000;
const LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** What is wrong with a proposal before it is sent (the route checks again): the words, or null. Line breaks and tabs are kept; any other control or format character is refused. */
export function proposalProblem(version: string, body: string): string | null {
  if (!LABEL.test(version)) return "bad_version";
  if (body.trim() === "" || body.length > MAX_BODY || /[\p{Cc}\p{Cf}]/u.test(body.replace(/[\n\r\t]/g, ""))) return "bad_body_text";
  return null;
}
