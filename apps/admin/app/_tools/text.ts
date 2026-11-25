// Small words shared by the tool pages, pure so a test covers them.
export { when, ageText } from "../_queue/age";
/** "draft_job" becomes "Draft job". */
export const humanKey = (k: string): string => { const t = k.replaceAll("_", " "); return t[0]!.toUpperCase() + t.slice(1); };
export const ROLE_LABEL: Record<string, string> = {
  account_reviewer: "Account reviewer", fetched_job_reviewer: "Fetched job reviewer", rules_data_editor: "Rules data editor", trust_and_safety: "Trust and safety",
  services_case_handler: "Services case handler", content_editor: "Content editor", administrator: "Administrator",
};
export const roleLabel = (r: string): string => ROLE_LABEL[r] ?? humanKey(r);
