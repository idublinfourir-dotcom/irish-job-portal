import { jobCount, type Count } from "../jobs/format";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-11-16" to "16 Nov 2026" (no locale or time zone involved); anything else comes back as it is. */
export const shortDate = (day: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : day;
};
export const eur = (n: number) => `€${new Intl.NumberFormat("en-IE").format(n)}`;
/** The stored sector name as a label: "health" is "Health", "IT" stays, "construction and engineering" keeps its words. */
export const sectorLabel = (s: string) => (s === "IT" ? s : s.charAt(0).toUpperCase() + s.slice(1));
/** "1 live job", "250+ live jobs" (the rule of every job count, #301). */
export const jobsIn = (c: Count) => `${jobCount(c)} live ${c.n === 1 ? "job" : "jobs"}`;
