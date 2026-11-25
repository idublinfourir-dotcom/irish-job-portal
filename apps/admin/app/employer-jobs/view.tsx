// The held employer and agency job queues as parts that take their data as props, so a test renders every state. Adverts and names are free text from outside: text only.
import type { AuthorityDocument, JobQueueItem } from "@portal/db";
import { A, EmptyState, Notice, Pager, Pill, Tabs, cx } from "@portal/ui";
import { Act } from "../_queue/act";
import { when } from "../_queue/age";
import { Head } from "../_queue/page-head";
import { approveText, bytes, dayOf, queueLabel, QUEUE_NOTE, REJECT_REASONS, rejectText, salaryText, type Queue, QUEUES } from "./text";

export type Detail = JobQueueItem & { advertText: string | null };
export const href = (queue: Queue, id?: string, after?: string) => `/employer-jobs?${new URLSearchParams({ queue, ...(id ? { id } : {}), ...(after ? { after } : {}) })}`;

export function List({ queue, items, selected, meId, next, prev }: { queue: Queue; items: JobQueueItem[]; selected?: string; meId: string; next?: string; prev?: string }) {
  if (items.length === 0) return <EmptyState icon="briefcase" title="Nothing is held here">{QUEUE_NOTE[queue]}</EmptyState>;
  return (
    <div className="flex flex-col gap-3">
      <ul className="overflow-hidden rounded-card border border-line bg-white">
        {items.map((i) => (
          <li key={i.id} className={cx("border-b border-line last:border-b-0", i.id === selected ? "bg-lilac" : "odd:bg-sand/60")}>
            <A href={href(queue, i.id)} aria-current={i.id === selected ? "true" : undefined} className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 no-underline">
              <span className="font-semibold [overflow-wrap:anywhere]">{i.title}</span>
              <span className="text-right">{i.status === "claimed" && <Pill tone="lilac" className="min-h-[30px] px-3 text-small">{i.claimedBy === meId ? "Yours" : "Claimed"}</Pill>}</span>
              <span className="col-span-2 text-small text-muted [overflow-wrap:anywhere]">{i.company}</span>
            </A>
          </li>
        ))}
      </ul>
      {(next || prev) && <Pager prevHref={prev} nextHref={next} />}
    </div>
  );
}

export function Authority({ jobId, documents }: { jobId: string; documents: AuthorityDocument[] }) {
  return (
    <section aria-label="Written authority" className="flex flex-col gap-2">
      <h3 className="text-[17px]">Client&apos;s written authority</h3>
      {documents.length === 0 ? <p className="text-small text-muted">The agency has not stored a copy.</p> : (
        <ul className="divide-y divide-line rounded-card bg-white">
          {documents.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-small">
              <span className="[overflow-wrap:anywhere]">{d.fileName ?? "Unnamed file"} · {bytes(d.sizeBytes)} · stored {when(d.uploadedAt)}</span>
              {d.copyDeleted ? <span className="text-muted">The copy was deleted</span> : (
                <A href={`/api/employer-jobs/authority?${new URLSearchParams({ jobId, docId: d.id })}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-deep-green underline">Open the copy</A>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-small text-muted">Opening a copy is written to the audit log. If the link shows scan_pending the copy is still being checked, and file_blocked means the check found a problem.</p>
    </section>
  );
}

export function DetailCard({ item, meId, documents, canOpenCompany, listHref }: { item: Detail; meId: string; documents: AuthorityDocument[] | null; canOpenCompany: boolean; listHref: string }) {
  const mine = item.claimedBy === meId;
  const here = href(item.queue, item.id);
  const url = "/api/employer-jobs";
  return (
    <section aria-label={`Review of ${item.title}`} className="flex flex-col gap-4 rounded-card bg-sand p-5 sm:p-6 lg:rounded-bento">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-[22px] [overflow-wrap:anywhere]">{item.title}</h2>
        <Pill tone="peach" className="min-h-[30px]">{queueLabel(item.queue)}</Pill>
      </header>
      <p className="text-small text-muted [overflow-wrap:anywhere]">
        {canOpenCompany ? <A href={`/companies/${item.organisationId}`} className="font-semibold text-deep-green underline">{item.company}</A> : item.company} · company {item.companyStatus.replaceAll("_", " ")}
      </p>
      {item.restricted && <Notice kind="warning">This company is under a strike restriction now.</Notice>}
      {item.reason && <p className="text-small [overflow-wrap:anywhere]">Held because: {item.reason.replaceAll("_", " ")}</p>}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-small">
        <dt className="text-muted">Employer</dt><dd className="[overflow-wrap:anywhere]">{item.employerName}</dd>
        <dt className="text-muted">Place</dt><dd>{item.county ?? "Not stated"}</dd>
        <dt className="text-muted">Occupation code</dt><dd>{item.occupationCode ?? "Not stated"}</dd>
        <dt className="text-muted">Permit</dt><dd>{item.permitType.replaceAll("_", " ")}</dd>
        <dt className="text-muted">Pay</dt><dd>{salaryText(item.salaryLow, item.salaryHigh, item.payGrade)}</dd>
        <dt className="text-muted">Job status</dt><dd>{item.jobStatus.replaceAll("_", " ")}</dd>
        <dt className="text-muted">Closes</dt><dd>{dayOf(item.closesAt)}</dd>
        {item.source === "agency" && <><dt className="text-muted">Client</dt><dd className="[overflow-wrap:anywhere]">{item.clientName ?? "Not named"} ({item.clientCheck.replaceAll("_", " ")})</dd></>}
      </dl>
      <div>
        <h3 className="mb-1 text-[17px]">Advert text</h3>
        <p className="whitespace-pre-wrap rounded-card bg-white p-4 text-small [overflow-wrap:anywhere]">{item.advertText ?? "The advert text was not saved."}</p>
      </div>
      {documents && <Authority jobId={item.jobId} documents={documents} />}
      {item.status === "done" && <p className="text-small text-muted">This item is decided. Every action is written to the audit log.</p>}
      {item.status === "open" && <Act url={url} fixed={{ action: "claim", itemId: item.id }} label="Claim this item" here={here} />}
      {item.status === "claimed" && !mine && (
        <div className="flex flex-col gap-3">
          <p className="text-small text-muted">Another reviewer holds this item. A claim can be taken over after 24 hours, or when its holder is no longer active.</p>
          <Act url={url} fixed={{ action: "claim", itemId: item.id }} label="Take over the claim" here={here} />
        </div>
      )}
      {item.status === "claimed" && mine && (
        <div className="flex flex-col gap-5">
          <Act url={url} fixed={{ action: "approve", itemId: item.id }} label="Approve" here={here} confirm={approveText(item.queue)} leave={listHref} />
          <Act url={url} fixed={{ action: "reject", itemId: item.id }} fields={[{ name: "reason", label: "Reason for Reject", kind: "select", options: REJECT_REASONS }]} label="Reject" variant="danger" here={here} confirm={rejectText(item.queue)} leave={listHref} />
          <Act url={url} fixed={{ action: "release", itemId: item.id }} label="Release" variant="outline" here={here} leave={listHref} />
        </div>
      )}
      {item.status !== "done" && <p className="text-small text-muted">Every action is written to the audit log.</p>}
    </section>
  );
}

export function EmployerJobs({ queues, queue, items, selected, missingId, meId, documents, canOpenCompany, next, prev }: {
  queues: Queue[]; queue: Queue; items: JobQueueItem[]; selected: Detail | null; missingId?: boolean; meId: string; documents: AuthorityDocument[] | null; canOpenCompany: boolean; next?: string; prev?: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <Head title="Held jobs">Employer and agency jobs that wait for a person before they go live, or stay live. {QUEUE_NOTE[queue]}</Head>
      <Tabs label="Held job queues" items={QUEUES.filter(([k]) => queues.includes(k)).map(([k, label]) => ({ label, href: href(k), active: k === queue }))} />
      {missingId && <Notice kind="warning">That item is not in a queue you can open. Pick one from the list.</Notice>}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_30rem]">
        <List queue={queue} items={items} selected={selected?.id} meId={meId} next={next} prev={prev} />
        {selected && <DetailCard item={selected} meId={meId} documents={documents} canOpenCompany={canOpenCompany} listHref={href(queue)} />}
      </div>
    </div>
  );
}
