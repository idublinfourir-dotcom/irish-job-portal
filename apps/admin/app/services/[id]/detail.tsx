// One services case (frame D11, the case panel, documents table and notes) as parts that take their data as props. A handler sees all of it; an administrator sees it
// without notes, copies or the requester's name and email (S-Q11 B), and the page then reads no copies. The employer's name, the handler's name and the date each copy was asked for are not in the reads (B73).
import { A, Notice, Pill } from "@portal/ui";
import { when } from "../../_queue/age";
import { COPIES_NOTE, FEE_NOTE, FROM_LABEL, KEEP_NOTE, CLOSE_LABEL, OUTCOME_LABEL, caseRef, holder, payerLabel, permitLabel, sideLabel, statusLabel, type CaseItem, type Doc } from "../text";
import { Actions, type Props } from "./actions";
import { OpenCopy } from "../../_queue/open-copy";

const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div className="grid gap-1 sm:grid-cols-[11rem_minmax(0,1fr)]"><dt className="text-muted">{k}</dt><dd className="[overflow-wrap:anywhere]">{children}</dd></div>
);

export type DocsState = { kind: "list"; docs: Doc[] } | { kind: "hidden"; why: "admin" | "not_mine" } | { kind: "error"; text: string };

export function Documents({ caseId, state, asked }: { caseId: string; state: DocsState; asked: CaseItem["documentsNeeded"] }) {
  return (
    <section className="flex flex-col gap-3 rounded-card bg-sand p-5 sm:p-6 lg:rounded-bento" aria-label="Documents">
      <h2 className="text-[22px]">Documents</h2>
      <p className="text-small text-muted">{COPIES_NOTE} {KEEP_NOTE}</p>
      {asked.length > 0 && (
        <p className="flex flex-wrap items-center gap-1.5 text-small">Asked for: {asked.map((a) => <Pill key={a.code} tone="peach" className="min-h-[30px] px-3">{a.label ?? a.code}</Pill>)}</p>
      )}
      {state.kind === "hidden" && <Notice kind="info">{state.why === "admin" ? "Administrators do not see the copies. Only the handler the case is assigned to does." : "Take this case to see its copies."}</Notice>}
      {state.kind === "error" && <Notice kind="error">{state.text}</Notice>}
      {state.kind === "list" && (state.docs.length === 0 ? <p className="text-muted">No copies have been uploaded yet.</p> : (
        <div className="overflow-x-auto rounded-card border border-line bg-white">
          <table className="w-full min-w-[34rem] text-left">
            <thead><tr className="border-b border-line text-small"><th className="px-4 py-3 font-semibold">Document</th><th className="px-4 py-3 font-semibold">From</th><th className="px-4 py-3 font-semibold">State</th><th className="px-4 py-3"><span className="sr-only">Open</span></th></tr></thead>
            <tbody>
              {state.docs.map((d) => (
                <tr key={d.id} className="border-b border-line last:border-b-0">
                  <td className="px-4 py-3 [overflow-wrap:anywhere]">{d.fileName ?? "Unnamed copy"}</td>
                  <td className="px-4 py-3 text-small">{FROM_LABEL[d.uploadedBy] ?? d.uploadedBy}</td>
                  <td className="px-4 py-3 text-small">{d.copyDeleted ? <Pill tone="neutral" className="min-h-[30px] px-3">Copy deleted</Pill> : <>Uploaded {when(d.uploadedAt)}</>}</td>
                  <td className="px-4 py-3 text-right">{d.copyDeleted ? null : <OpenCopy url={`/api/services/cases/${encodeURIComponent(caseId)}/documents/${encodeURIComponent(d.id)}`} name={d.fileName ?? "copy"} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}

export function Notes({ item }: { item: CaseItem }) {
  const notes = item.notes ?? [];
  return (
    <section className="flex flex-col gap-3 rounded-card bg-sand p-5 sm:p-6 lg:rounded-bento" aria-label="Notes">
      <h2 className="text-[22px]">Notes</h2>
      <p className="text-small text-muted">Staff only. A note is never shown to the requester.</p>
      {notes.length === 0 ? <p className="text-muted">No notes yet.</p> : (
        <ul className="flex flex-col gap-2">
          {notes.map((n) => <li key={n.id} className="rounded-card bg-white p-3"><p className="text-small text-muted">{when(n.createdAt)}</p><p className="whitespace-pre-line [overflow-wrap:anywhere]">{n.body}</p></li>)}
        </ul>
      )}
    </section>
  );
}

export function CaseView({ item, meId, isHandler, isAdmin, docs, handlers, solicitors }: { item: CaseItem; meId: string; isHandler: boolean; isAdmin: boolean; docs: DocsState; handlers: Props["handlers"]; solicitors: Props["solicitors"] }) {
  const held = holder(item.assignedStaffUserId, meId);
  const offer = item.offerDetails?.details ?? {};
  const closed = item.status === "closed";
  return (
    <div className="flex flex-col gap-6">
      <A href="/services" className="self-start text-small font-semibold">Back to services cases</A>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <section className="flex flex-col gap-4 rounded-card bg-sand p-5 sm:p-6 lg:rounded-bento" aria-label={`Case ${caseRef(item.id)}`}>
            <header className="flex flex-wrap items-start justify-between gap-2">
              <h1 className="text-[26px] leading-tight [overflow-wrap:anywhere]">{caseRef(item.id)} · {permitLabel(item.permitType)}</h1>
              <Pill tone={closed ? "neutral" : "peach"} className="min-h-[30px]">{statusLabel(item.status)}</Pill>
            </header>
            <dl className="flex flex-col gap-2">
              <Row k="Requested by">{sideLabel(item.side)}</Row>
              {isHandler && <Row k="Requester">{item.requesterErased ? "Removed at the requester's request" : item.requesterName ? `${item.requesterName}${item.requesterEmail ? ` · ${item.requesterEmail}` : ""}` : "Not shown once the case is closed"}</Row>}
              <Row k="Who pays">{payerLabel(item.payer)}. {FEE_NOTE}</Row>
              {offer.title && <Row k="Job title">{offer.title}</Row>}
              {offer.employerName && <Row k="Employer named">{offer.employerName}</Row>}
              <Row k="Assigned to">{held === "me" ? "You" : held === "none" ? "Nobody yet" : "Another handler"}</Row>
              <Row k="Opened">{when(item.createdAt)}</Row>
              <Row k="HR contact">{item.hrContactConsent ? "The requester agreed we may contact the employer's HR" : "Not agreed"}</Row>
              {item.decisionOutcome && <Row k="Outcome">{OUTCOME_LABEL[item.decisionOutcome] ?? item.decisionOutcome}{item.decidedAt ? `, ${when(item.decidedAt)}` : ""}</Row>}
              {closed && <Row k="Closed">{CLOSE_LABEL[item.closeReason ?? ""] ?? "Closed"}{item.closedAt ? `, ${when(item.closedAt)}` : ""}</Row>}
            </dl>
          </section>
          <Documents caseId={item.id} state={docs} asked={item.documentsNeeded} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <section className="flex flex-col gap-4 rounded-card bg-sand p-5 sm:p-6 lg:rounded-bento" aria-label="Actions">
            <h2 className="text-[22px]">Actions</h2>
            <Actions caseId={item.id} status={item.status} outcome={item.decisionOutcome} held={held} isHandler={isHandler} isAdmin={isAdmin} meId={meId} handlers={handlers} solicitors={solicitors} />
          </section>
          {isHandler ? <Notes item={item} /> : <Notice kind="info">Administrators do not see notes, copies or the requester&apos;s name.</Notice>}
        </div>
      </div>
    </div>
  );
}
