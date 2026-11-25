// The pay floor check queue (#82, #104) as parts that take their data as props, so a test renders every state. A floor is proposed by a rules data editor, then
// confirmed by an administrator who did not propose it: the page never offers the same person both steps (the route refuses it too).
import type { FloorCheck } from "@portal/db";
import { A, EmptyState, Notice, Pager, Pill, cx } from "@portal/ui";
import { Act } from "../_queue/act";
import { ageText, when } from "../_queue/age";
import { Head } from "../_queue/page-head";
import { floorLine, REJECT_REASONS, stepFor } from "./text";

export const href = (id?: string, after?: string) => `/pay-floors${new URLSearchParams({ ...(id ? { id } : {}), ...(after ? { after } : {}) }).toString().replace(/^(?=.)/, "?")}`;

export function List({ items, selected, now, next, prev }: { items: FloorCheck[]; selected?: string; now: Date; next?: string; prev?: string }) {
  if (items.length === 0) return <EmptyState icon="clipboard" title="No pay floor is waiting">Floors signed by big companies appear here for a check.</EmptyState>;
  return (
    <div className="flex flex-col gap-3">
      <ul className="overflow-hidden rounded-card border border-line bg-white">
        {items.map((i) => (
          <li key={i.floorId} className={cx("border-b border-line last:border-b-0", i.floorId === selected ? "bg-lilac" : "odd:bg-sand/60")}>
            <A href={href(i.floorId)} aria-current={i.floorId === selected ? "true" : undefined} className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 no-underline">
              <span className="font-semibold [overflow-wrap:anywhere]">{i.displayName}</span>
              <span className="text-right text-small">{ageText(i.createdAt, now)}</span>
              <span className="text-small text-muted">Occupation code {i.roleFamily}</span>
              <span className="text-right">{i.requestId !== null && <Pill tone="lilac" className="min-h-[30px] px-3 text-small">Proposed</Pill>}</span>
            </A>
          </li>
        ))}
      </ul>
      {(next || prev) && <Pager prevHref={prev} nextHref={next} />}
    </div>
  );
}

export function Detail({ f, meId, roles, now }: { f: FloorCheck; meId: string; roles: readonly string[]; now: Date }) {
  const step = stepFor(f, meId, roles);
  const here = href(f.floorId);
  const url = "/api/pay-floors";
  const canReject = roles.includes("rules_data_editor") || roles.includes("administrator");
  return (
    <section aria-label={`Pay floor of ${f.displayName}`} className="flex flex-col gap-4 rounded-card bg-sand p-5 sm:p-6 lg:rounded-bento">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-[22px] [overflow-wrap:anywhere]">{f.displayName}</h2>
        <Pill tone="peach" className="min-h-[30px]">{f.requestId === null ? "Waiting for a proposal" : "Waiting for a second person"}</Pill>
      </header>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-small">
        <dt className="text-muted">Occupation code</dt><dd>{f.roleFamily}</dd>
        <dt className="text-muted">Floor</dt><dd>{floorLine(f)}</dd>
        <dt className="text-muted">Signed</dt><dd className="[overflow-wrap:anywhere]">{when(f.signedAt)} by {f.signerName ?? "an unnamed signer"}{f.signerTitle ? `, ${f.signerTitle}` : ""}</dd>
        <dt className="text-muted">Window</dt><dd>Until {when(f.validUntil)}</dd>
        <dt className="text-muted">Waiting</dt><dd>{ageText(f.createdAt, now)}</dd>
        <dt className="text-muted">Company</dt><dd>{f.kind} · {f.organisationStatus.replaceAll("_", " ")}</dd>
      </dl>
      {!f.isBigCompany && <Notice kind="warning">This company is no longer on the big-company list, so its floor cannot be confirmed. Reject it.</Notice>}
      {step === "propose" && <Act url={url} fixed={{ action: "propose", floorId: f.floorId }} label="Propose to confirm" here={here} confirm="Propose this floor for confirmation? A different administrator then confirms it." />}
      {step === "confirm" && <Act url={url} fixed={{ action: "confirm", floorId: f.floorId }} label="Confirm" here={here} confirm="Confirm this floor? It takes effect now and the employer is told." leave={href()} />}
      {step === "wait_second" && <Notice kind="info">{f.proposedBy === meId ? "You proposed this floor. A different administrator has to confirm it." : "A rules data editor proposed this floor. An administrator confirms it."}</Notice>}
      {step === "wait_other" && <Notice kind="info">A rules data editor has to propose this floor first. Then you can confirm it.</Notice>}
      {canReject && <Act url={url} fixed={{ action: "reject", floorId: f.floorId }} fields={[{ name: "reason", label: "Reason for Reject", kind: "select", options: REJECT_REASONS }]} label="Reject" variant="danger" here={here} confirm="Reject this floor? The employer is told." leave={href()} />}
      <p className="text-small text-muted">Every action is written to the audit log.</p>
    </section>
  );
}

export function PayFloors({ items, selected, missingId, meId, roles, now, next, prev }: { items: FloorCheck[]; selected: FloorCheck | null; missingId?: boolean; meId: string; roles: readonly string[]; now: Date; next?: string; prev?: string }) {
  return (
    <div className="flex flex-col gap-6">
      <Head title="Pay floor checks">Pay floors signed by big companies. A rules data editor proposes, then a different administrator confirms.</Head>
      {missingId && <Notice kind="warning">That pay floor does not exist. Pick one from the list.</Notice>}
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_28rem]">
        <List items={items} selected={selected?.floorId} now={now} next={next} prev={prev} />
        {selected && <Detail f={selected} meId={meId} roles={roles} now={now} />}
      </div>
    </div>
  );
}
