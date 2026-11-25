// The words of the contact inbox, pure so a test covers them. The message itself is free text from a visitor: it is only ever shown as text.
export const TOPICS: Record<string, string> = { general: "General question", account: "Account", data_request: "Data request", appeal: "Appeal", other: "Other" };
export const SURFACES: Record<string, string> = { candidate: "Candidate site", portal: "Employer portal" };
const plain = (code: string) => code.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
export const topicLabel = (t: string): string => TOPICS[t] ?? plain(t);
export const surfaceLabel = (s: string | null): string => (s === null ? "Not recorded" : (SURFACES[s] ?? plain(s)));
export const STATUS_LABEL: Record<string, string> = { new: "New", claimed: "Claimed", answered: "Answered", closed: "Closed", spam: "Marked as spam" };

/** Staff who may act on a message (the route's x-roles for POST); an administrator only reads. */
export const ACTING_ROLES = ["services_case_handler", "content_editor"] as const;
export const mayAct = (roles: readonly string[]) => roles.some((r) => (ACTING_ROLES as readonly string[]).includes(r));
