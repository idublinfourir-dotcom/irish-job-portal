// The words of the held employer and agency job queues, pure so a test covers them. The advert text is free text from an employer: it is only ever shown as text.
export const QUEUES = [
  ["scam_flag", "Scam check", "trust_and_safety"],
  ["post_strike_job_review", "After a strike", "account_reviewer"],
  ["agency_client_check", "Agency client check", "account_reviewer"],
  ["licence_lapse_job", "Licence lapse", "account_reviewer"],
] as const;
export type Queue = (typeof QUEUES)[number][0];
export const isQueue = (v: string | undefined): v is Queue => QUEUES.some(([k]) => k === v);
export const queueLabel = (q: string): string => QUEUES.find(([k]) => k === q)?.[1] ?? q.replaceAll("_", " ");
/** The queues a staff member holding these roles may read and decide (the route's x-roles: a queue's own role, or administrator). */
export const queuesFor = (roles: readonly string[]): Queue[] => QUEUES.filter(([, , role]) => roles.includes(role) || roles.includes("administrator")).map(([k]) => k);
/** Who may open the company page the item links to. */
export const mayOpenCompany = (roles: readonly string[]) => roles.includes("account_reviewer") || roles.includes("administrator");

export const QUEUE_NOTE: Record<Queue, string> = {
  scam_flag: "Jobs held because they look like a scam.",
  post_strike_job_review: "Jobs held because the company is under a strike restriction.",
  agency_client_check: "Agency jobs held until the client and the client's written authority are checked.",
  licence_lapse_job: "Live jobs of an agency whose licence was not found on the register.",
};
export const REJECT_REASONS: readonly (readonly [string, string])[] = [
  ["scam_suspected", "Looks like a scam"], ["not_a_real_job", "Not a real job"], ["client_not_confirmed", "Client not confirmed"],
  ["authority_missing", "No written authority"], ["licence_not_valid", "Licence not valid"], ["other", "Another reason"],
];
export const approveText = (q: string) => q === "licence_lapse_job" ? "The job stays live and the item is closed." : "The item is closed. The job goes live when no other check still holds it.";
export const rejectText = (q: string) => q === "licence_lapse_job" ? "The job is closed as removed." : "The job is closed as removed and the employer is told.";

const DAY = new Intl.DateTimeFormat("en-IE", { timeZone: "Europe/Dublin", day: "numeric", month: "short", year: "numeric" });
export const dayOf = (d: Date | string): string => DAY.format(new Date(d));
export const eur = (n: number) => `€${n.toLocaleString("en-IE")}`;
export const salaryText = (low: number | null, high: number | null, grade: string | null): string =>
  low === null && high === null ? (grade ? `Pay grade ${grade}` : "No pay stated") : low !== null && high !== null && high !== low ? `${eur(low)} to ${eur(high)} a year` : `${eur((low ?? high)!)} a year`;
export const bytes = (n: number | null): string => (n === null ? "" : n < 1024 ** 2 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
