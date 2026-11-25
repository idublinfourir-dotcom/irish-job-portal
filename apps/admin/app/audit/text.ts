// The words and filters of the audit log (frame D13). Pure. The filter shapes are the ones docs/openapi/admin.yaml gives GET /api/audit and /api/audit/export; a value that does not
// have the shape is left out (never an error page) so a hostile address reads the log with no filter.
import type { AuditRow } from "@portal/db";
import { auditInitials, auditSentence } from "../_queue/audit-text";

export const KINDS = [["", "All actions"], ["admin_action", "Admin actions"], ["data_access", "Personal data views"], ["security", "Security"]] as const;
export type Filters = { kind?: string; action?: string; staff?: string; q?: string; from?: string; to?: string };
const SHAPE: Record<keyof Filters, RegExp> = {
  kind: /^(admin_action|data_access|security)$/, action: /^[a-z][a-z0-9_.]{0,80}$/, staff: /^[A-Za-z0-9_-]{1,64}$/, q: /^[A-Za-z0-9_.:-]{1,100}$/, from: /^\d{4}-\d\d-\d\d$/, to: /^\d{4}-\d\d-\d\d$/,
};

/** The filters in an address, each kept only when it has the shape the route takes. */
export function cleanFilters(q: Record<string, string | undefined>): Filters {
  const out: Filters = {};
  for (const k of Object.keys(SHAPE) as (keyof Filters)[]) {
    const v = q[k];
    if (v !== undefined && SHAPE[k].test(v) && (k !== "from" && k !== "to" || !Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) out[k] = v;
  }
  return out;
}
/** The route's query (no `after`): a text with a colon is a case reference, any other is an object number. */
export function routeQuery(f: Filters, after?: string): string {
  const p = new URLSearchParams();
  if (f.kind) p.set("kind", f.kind);
  if (f.action) p.set("action", f.action);
  if (f.staff) p.set("staff", f.staff);
  if (f.q) p.set(f.q.includes(":") ? "case" : "objectId", f.q);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (after) p.set("after", after);
  return p.toString();
}
/** The page's own address for these filters (the `q` text stays as typed). */
export const href = (f: Filters, after?: string): string => {
  const p = new URLSearchParams(Object.entries(f).filter((e): e is [string, string] => e[1] !== undefined));
  if (after) p.set("after", after);
  return `/audit${p.size ? `?${p}` : ""}`;
};

const cut = (t: string) => (t.length > 40 ? `${t.slice(0, 40)}...` : t);
const show = (v: unknown) => (v === undefined || v === null ? "none" : cut(typeof v === "string" ? (/^[a-z][a-z0-9_]*$/.test(v) ? v.replaceAll("_", " ") : v) : JSON.stringify(v)));
/** "Pending review → Verified" for each changed column: the first three, then how many more. "-" when the row changed nothing (a personal data view). */
export function changeText(r: Pick<AuditRow, "changedColumns" | "before" | "after">): string {
  const b = r.before && typeof r.before === "object" ? (r.before as Record<string, unknown>) : null;
  const a = r.after && typeof r.after === "object" ? (r.after as Record<string, unknown>) : null;
  const cols = r.changedColumns?.length ? r.changedColumns : [...new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])];
  if (cols.length === 0) return "-";
  const parts = cols.slice(0, 3).map((c) => (b && c in b ? `${c.replaceAll("_", " ")}: ${show(b[c])} → ${show(a?.[c])}` : `${c.replaceAll("_", " ")}: ${show(a?.[c])}`));
  return cols.length > 3 ? `${parts.join("; ")}; ${cols.length - 3} more` : parts.join("; ");
}
export const actorName = (r: Pick<AuditRow, "actor">): string => r.actor.staffName ?? (r.actor.system ? "System" : r.actor.candidate ? "A candidate" : r.actor.portal ? "An employer" : "Unknown");
export const actorInitials = (r: Pick<AuditRow, "actor">): string => auditInitials(r.actor.staffName);
export const actionText = (action: string): string => { const t = auditSentence(action); return t.charAt(0).toUpperCase() + t.slice(1); };
export const objectText = (r: Pick<AuditRow, "objectLabel" | "objectType" | "objectId">): string => r.objectLabel ?? (r.objectType && r.objectId ? `${r.objectType.replaceAll("_", " ")} ${r.objectId}` : "-");
