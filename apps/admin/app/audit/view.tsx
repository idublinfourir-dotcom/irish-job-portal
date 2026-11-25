// The audit log (frame D13) as parts that take their data as props, so a test renders every state. An administrator reads every row and may filter by person; any other staff
// member reads their own rows only (CF104, #234 D2). Previous and Next only (CF115). Nothing here reads.
import type { AuditRow } from "@portal/db";
import { Button, EmptyState, Input, Notice, Pager, Select } from "@portal/ui";
import { clock, parse } from "../_queue/age";
import { AUDIT_ACTIONS } from "../_queue/audit-text";
import { ExportButton } from "./export";
import { actionText, actorInitials, actorName, changeText, Filters, href, KINDS, objectText, routeQuery } from "./text";

const DAY = new Intl.DateTimeFormat("en-IE", { timeZone: "Europe/Dublin", day: "2-digit", month: "short" });
const whenText = (at: string) => `${DAY.format(parse(at))} ${clock(at)}`;

export function Rows({ events }: { events: AuditRow[] }) {
  if (events.length === 0) return <EmptyState icon="clock" title="No rows match">Clear a filter, or widen the dates.</EmptyState>;
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-white">
      <table className="w-full min-w-[44rem] text-left text-small">
        <thead>
          <tr className="border-b border-line"><th className="px-4 py-3 font-semibold">When</th><th className="px-4 py-3 font-semibold">Who</th><th className="px-4 py-3 font-semibold">Action</th><th className="px-4 py-3 font-semibold">Object</th><th className="px-4 py-3 font-semibold">Before → after</th></tr>
        </thead>
        <tbody>
          {events.map((r) => (
            <tr key={r.id} className="border-b border-line align-top odd:bg-sand/60 last:border-b-0">
              <td className="whitespace-nowrap px-4 py-3 text-muted">{whenText(r.at)}</td>
              <td className="px-4 py-3"><span className="flex items-center gap-2"><span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-pill bg-green-tint text-caption font-semibold">{actorInitials(r)}</span><span className="[overflow-wrap:anywhere]">{actorName(r)}</span></span></td>
              <td className="px-4 py-3 font-semibold">{actionText(r.action)}</td>
              <td className="px-4 py-3 [overflow-wrap:anywhere]">{objectText(r)}</td>
              <td className="px-4 py-3 text-muted [overflow-wrap:anywhere]">{changeText(r)}{r.secondStaffName ? ` (second person: ${r.secondStaffName})` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Audit({ events, filters, isAdmin, people, next, prev, notice }: { events: AuditRow[]; filters: Filters; isAdmin: boolean; people: { id: string; name: string }[]; next?: string; prev?: string; notice?: string }) {
  const here = href(filters);
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 text-[32px] leading-tight md:text-[34px]">Audit log</h1>
          <p className="text-muted">{isAdmin ? "Every admin action, and every staff view of candidate data." : "Your own actions. An administrator reads the whole log."}</p>
        </div>
        <ExportButton query={routeQuery(filters)} back={here} />
      </header>
      <nav aria-label="Kind of row" className="flex flex-wrap gap-2">
        {KINDS.map(([k, label]) => (
          <Button key={label} href={href({ ...filters, kind: k || undefined })} variant={(filters.kind ?? "") === k ? "filter-on" : "chip"} aria-current={(filters.kind ?? "") === k ? "true" : undefined}>{label}</Button>
        ))}
      </nav>
      <form method="get" action="/audit" className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-6">
        {filters.kind && <input type="hidden" name="kind" value={filters.kind} />}
        {isAdmin && (
          <Select label="Person" name="staff" defaultValue={filters.staff ?? ""}>
            <option value="">Everyone</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        )}
        <Select label="Action" name="action" defaultValue={filters.action ?? ""}>
          <option value="">Any action</option>
          {AUDIT_ACTIONS.map((a) => <option key={a} value={a}>{actionText(a)}</option>)}
          {filters.action && !AUDIT_ACTIONS.includes(filters.action) && <option value={filters.action}>{actionText(filters.action)}</option>}
        </Select>
        <Input label="Object or case" name="q" defaultValue={filters.q ?? ""} maxLength={100} placeholder="310 or strike:12" />
        <Input label="From" name="from" type="date" defaultValue={filters.from ?? ""} />
        <Input label="To" name="to" type="date" defaultValue={filters.to ?? ""} />
        <div className="flex gap-2"><Button type="submit" variant="dark" size="md">Filter</Button>{Object.keys(filters).length > 0 && <Button href="/audit" variant="outline" size="md">Clear</Button>}</div>
      </form>
      {notice && <Notice kind="warning">{notice}</Notice>}
      <Rows events={events} />
      {(next || prev) && <Pager prevHref={prev} nextHref={next} />}
    </div>
  );
}
