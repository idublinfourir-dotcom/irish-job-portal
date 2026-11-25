// The services board (frame D11) as parts that take their data as props, so a test renders every state. The page (page.tsx) reads and hands them over.
// #287: no "Ready to submit" column and no "New case" button (L40); no candidate-pays lane (#84). Requester name, employer, handler name and days in status are not in the
// list read (B73), so a card shows what the read gives: reference, permit, payer, who asked, age and who holds it (you, nobody, someone else).
import { A, EmptyState, Notice, Pager, Pill, cx } from "@portal/ui";
import { ageText } from "../_queue/age";
import { COPIES_NOTE, FEE_NOTE, STATUSES, caseRef, holder, payerLabel, permitLabel, sideLabel, statusLabel, type Row, type Status } from "./text";

export type View = "board" | "table";
export type Who = "all" | "mine" | "unassigned";
export const WHO: readonly [Who, string][] = [["all", "All"], ["mine", "Mine"], ["unassigned", "Unassigned"]];
export const isWho = (v: string | undefined): v is Who => WHO.some(([k]) => k === v);

export const href = (o: { view?: View; status?: Status; who?: Who; after?: string }) =>
  `/services?${new URLSearchParams({ ...(o.view === "table" ? { view: "table" } : {}), ...(o.view === "table" && o.status && o.status !== "received" ? { status: o.status } : {}), ...(o.who && o.who !== "all" ? { who: o.who } : {}), ...(o.after ? { after: o.after } : {}) })}`.replace(/\?$/, "");

export const keep = (rows: Row[], who: Who, me: string) => (who === "mine" ? rows.filter((r) => r.assignedStaffUserId === me) : who === "unassigned" ? rows.filter((r) => r.assignedStaffUserId === null) : rows);

function Holder({ assigned, me }: { assigned: string | null; me: string }) {
  const h = holder(assigned, me);
  return <Pill tone={h === "me" ? "green" : h === "none" ? "peach" : "lilac"} className="min-h-[30px] px-3">{h === "me" ? "Yours" : h === "none" ? "Unassigned" : "Assigned"}</Pill>;
}

export function Card({ r, me, now }: { r: Row; me: string; now: Date }) {
  return (
    <A href={`/services/${r.id}`} className="flex flex-col gap-2 rounded-card bg-white p-4 no-underline shadow-card">
      <span className="text-small text-muted">{caseRef(r.id)}</span>
      <span className="font-semibold [overflow-wrap:anywhere]">{permitLabel(r.permitType)}</span>
      <span className="text-small text-muted">{sideLabel(r.side)} asked · {ageText(r.createdAt, now)} ago</span>
      <span className="flex flex-wrap gap-1.5">
        <Holder assigned={r.assignedStaffUserId} me={me} />
        <Pill tone="lilac" className="min-h-[30px] px-3">{payerLabel(r.payer)} pays</Pill>
      </span>
    </A>
  );
}

export function Board({ columns, who, me, now }: { columns: { status: Status; rows: Row[]; more: boolean }[]; who: Who; me: string; now: Date }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2 xl:grid-cols-5">
      {columns.map((c) => {
        const rows = keep(c.rows, who, me);
        return (
          <section key={c.status} aria-label={statusLabel(c.status)} className="flex flex-col gap-3 rounded-bento bg-sand p-4">
            <h2 className="flex items-center justify-between gap-2 font-sans text-base font-semibold">
              <A href={href({ view: "table", status: c.status, who })} className="no-underline">{statusLabel(c.status)}</A>
              <span>{rows.length}{c.more && who === "all" ? "+" : ""}</span>
            </h2>
            {rows.length === 0 ? <p className="text-small text-muted">Nothing here.</p> : rows.map((r) => <Card key={r.id} r={r} me={me} now={now} />)}
            {c.more && <A href={href({ view: "table", status: c.status, who })} className="text-small font-semibold">See all {statusLabel(c.status).toLowerCase()}</A>}
          </section>
        );
      })}
    </div>
  );
}

export function Table({ status, rows, who, me, now, next, prev }: { status: Status; rows: Row[]; who: Who; me: string; now: Date; next?: string; prev?: string }) {
  const shown = keep(rows, who, me);
  return (
    <div className="flex flex-col gap-3">
      <nav aria-label="Status" className="flex gap-1 overflow-x-auto border-b border-line">
        {STATUSES.map((s) => (
          <A key={s} href={href({ view: "table", status: s, who })} aria-current={s === status ? "page" : undefined} className={cx("flex min-h-11 shrink-0 items-center border-b-4 px-3 text-small font-semibold no-underline", s === status ? "border-deep-green text-deep-green" : "border-transparent text-ink hover:border-line")}>{statusLabel(s)}</A>
        ))}
      </nav>
      {shown.length === 0 ? (
        <EmptyState icon="file" title={`No ${statusLabel(status).toLowerCase()} cases${who === "all" ? "" : " match this filter"}`}>Open cases appear here as people ask for permit help.</EmptyState>
      ) : (
        <div className="overflow-hidden rounded-card border border-line bg-white">
          <div aria-hidden="true" className="hidden grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_6rem_6rem] gap-3 border-b border-line px-4 py-3 text-small font-semibold md:grid">
            <span>Case</span><span>Permit</span><span>Asked by</span><span>Pays</span><span>Held by</span><span className="text-right">Age</span>
          </div>
          <ul>
            {shown.map((r) => (
              <li key={r.id} className="border-b border-line last:border-b-0 odd:bg-sand/60">
                <A href={`/services/${r.id}`} className="grid min-h-14 grid-cols-2 items-center gap-x-3 gap-y-1 px-4 py-3 no-underline md:grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_6rem_6rem]">
                  <span className="font-semibold">{caseRef(r.id)}</span>
                  <span className="[overflow-wrap:anywhere]">{permitLabel(r.permitType)}</span>
                  <span className="text-small">{sideLabel(r.side)}</span>
                  <span className="text-small">{payerLabel(r.payer)}</span>
                  <span><Holder assigned={r.assignedStaffUserId} me={me} /></span>
                  <span className="text-right text-small">{ageText(r.createdAt, now)}</span>
                </A>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(next || prev) && <Pager prevHref={prev} nextHref={next} />}
    </div>
  );
}

const seg = (on: boolean) => cx("inline-flex min-h-11 items-center rounded-pill px-5 font-semibold no-underline", on ? "bg-white text-ink shadow-card" : "text-ink");
const chip = (on: boolean) => cx("inline-flex min-h-11 items-center rounded-pill px-4 text-small font-semibold no-underline", on ? "bg-deep-green text-white" : "bg-lilac text-ink");

/** The whole page body. `rows` are the open page of one status (table); `columns` the first page of each status (board). */
export function Services(p: { view: View; status: Status; who: Who; me: string; now: Date; columns?: { status: Status; rows: Row[]; more: boolean }[]; rows?: Row[]; next?: string; prev?: string }) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="mb-1 text-[32px] leading-tight md:text-[34px]">Services cases</h1>
          <p className="text-muted">{COPIES_NOTE} {FEE_NOTE}</p>
        </div>
        <nav aria-label="View" className="flex gap-1 rounded-pill bg-lilac p-1">
          <A href={href({ view: "board", who: p.who })} aria-current={p.view === "board" ? "page" : undefined} className={seg(p.view === "board")}>Board</A>
          <A href={href({ view: "table", status: p.status, who: p.who })} aria-current={p.view === "table" ? "page" : undefined} className={seg(p.view === "table")}>Table</A>
        </nav>
      </header>
      <nav aria-label="Filter" className="flex flex-wrap gap-2">
        {WHO.map(([k, label]) => <A key={k} href={href({ view: p.view, status: p.status, who: k })} aria-current={k === p.who ? "page" : undefined} className={chip(k === p.who)}>{label}</A>)}
      </nav>
      {p.who !== "all" && <Notice kind="info">The filter works on the first 20 cases of each status.</Notice>}
      {p.view === "board" ? <Board columns={p.columns ?? []} who={p.who} me={p.me} now={p.now} /> : <Table status={p.status} rows={p.rows ?? []} who={p.who} me={p.me} now={p.now} next={p.next} prev={p.prev} />}
    </div>
  );
}
