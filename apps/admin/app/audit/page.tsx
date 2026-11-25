import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readAudit, readMe, readStaff, type AuditFilter } from "../../lib/data";
import { guarded, one } from "../_queue/guard";
import { Audit } from "./view";
import { cleanFilters, href, type Filters } from "./text";

export const metadata: Metadata = { title: `Audit log, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;
const KEYS = ["kind", "action", "staff", "q", "from", "to"];
/** The route's filter: a text with a colon is a case reference, any other is an object number. */
const toRead = (f: Filters, after?: string): AuditFilter => ({ kind: f.kind, action: f.action, staff: f.staff, from: f.from, to: f.to, ...(f.q ? (f.q.includes(":") ? { case: f.q } : { objectId: f.q }) : {}), after });

export default async function Page({ searchParams }: { searchParams: Promise<Params> }) {
  const q = await searchParams;
  const wanted = cleanFilters(Object.fromEntries(KEYS.map((k) => [k, one(q[k])])));
  const after = one(q.after);
  // Any active staff member reads the log, so there is no wrong-role page here: the role only changes what is in it (a visitor is sent to sign in by guarded).
  const r = await guarded(async () => {
    const isAdmin = (await readMe()).roles.includes("administrator");
    let filters: Filters = { ...wanted };
    if (!isAdmin) delete filters.staff; // a non-administrator reads their own rows only; the route refuses another member's id
    let notice: string | undefined;
    let list;
    try {
      list = await readAudit(toRead(filters, after));
    } catch (e) {
      const why = e instanceof Error ? e.message.split(":")[0] : "";
      if (why !== "bad_cursor" && why !== "bad_range") throw e;
      notice = why === "bad_range" ? "The first day is after the last day, so the dates were not used." : "That page link is not valid, so this is the first page.";
      if (why === "bad_range") filters = { ...filters, from: undefined, to: undefined };
      list = await readAudit(toRead(filters));
    }
    const people = isAdmin ? (await readStaff()).staff.map((s) => ({ id: s.id, name: s.name })) : [];
    return { isAdmin, filters: Object.fromEntries(Object.entries(filters).filter((e) => e[1] !== undefined)) as Filters, list, people, notice };
  });
  if (r.refused) return null; // not reached: no role is refused here
  const { isAdmin, filters, list, people, notice } = r.value;
  return <Audit events={list.events} filters={filters} isAdmin={isAdmin} people={people} notice={notice} next={list.next ? href(filters, list.next) : undefined} prev={after ? href(filters) : undefined} />;
}
