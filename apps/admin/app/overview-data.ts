// What the overview shows from the reads: the oldest waiting items across the queues the member works, and the next rules change. Pure, so a test covers it.
import type { QueueItem, ReviewItem } from "@portal/db";
import { parse } from "./_queue/age";
import { flagsOf, typeLabel } from "./account-reviews/text";
import { stageLabel } from "./fetched-jobs/text";
import type { Upcoming, Work } from "./overview";

export const WORK_ROWS = 5;
type Report = Record<string, unknown>;
const text = (v: unknown) => (typeof v === "string" ? v : "");
const words = (code: string) => (code ? code[0]!.toUpperCase() + code.slice(1).replaceAll("_", " ") : "Open report");

/** The oldest items first, across the lists given (a list the member may not read is null: it adds nothing). */
export function workRows(o: { accounts: ReviewItem[] | null; fetched: QueueItem[] | null; reports: Report[] | null }): Work[] {
  const rows: Work[] = [
    ...(o.accounts ?? []).map((i): Work => ({ key: `a${i.id}`, title: i.displayName, queue: "Account reviews", why: flagsOf(i)[0]?.text ?? typeLabel(i), since: i.createdAt, href: `/account-reviews?id=${i.id}` })),
    ...(o.fetched ?? []).map((i): Work => ({ key: `f${i.id}`, title: `${i.title} · ${i.employerName}`, queue: "Fetched jobs", why: stageLabel(i.stage), since: i.queuedAt, href: `/fetched-jobs?id=${i.id}` })),
    ...(o.reports ?? []).map((r): Work => ({ key: `r${text(r.id)}`, title: text(r.jobTitle) || text(r.displayName) || "A report", queue: "Reports", why: words(text(r.reason)), since: text(r.createdText), href: "/reports" })),
  ];
  return rows.filter((r) => r.since !== "").sort((a, b) => parse(a.since).getTime() - parse(b.since).getTime()).slice(0, WORK_ROWS);
}

/** The first confirmed rules version still to start, and every kind that starts that day. */
export function nextRules(upcoming: { kind: string; effectiveFrom: string }[]): Upcoming | null {
  const first = [...upcoming].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
  return first ? { from: first.effectiveFrom, kinds: [...new Set(upcoming.filter((u) => u.effectiveFrom === first.effectiveFrom).map((u) => u.kind))] } : null;
}
