// The data requests page (administrators) as parts that take their data as props. It shows what the read returns and nothing else: the requester's email from its
// contact message, where the owner's confirmation stands, and the erasures waiting for a second administrator.
import { Notice, Pill } from "@portal/ui";
import { when } from "../_tools/text";
import { Controls } from "./controls";
import { canProposeErase, confirmText, kindLabel, surfaceLabel } from "./text";

export type Item = { itemId: string; status: string; createdAt: string; surface: string; email: string | null; signedIn: boolean; confirmPurpose: string | null; confirmSentAt: string | null; confirmedAt: string | null };
export type PendingErase = { requestId: string; itemId: string; kind: string; proposedBy: string; createdAt: string };

export function DataRequests({ items, truncated, pending, meId }: { items: Item[]; truncated: boolean; pending: PendingErase[]; meId: string }) {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="mb-1 text-[32px] leading-tight md:text-[34px]">Data requests</h1>
        <p className="text-muted">People asking for their data or its erasure. Staff never receive the data: the account owner confirms from a link emailed to their own address and downloads the export on their own site.</p>
      </header>
      <section aria-label="Erasures waiting" className="flex flex-col gap-3">
        <h2 className="text-[22px]">Erasures waiting for a second administrator</h2>
        {pending.length === 0 && <p className="text-muted">None waiting.</p>}
        {pending.map((e) => {
          const item = items.find((i) => i.itemId === e.itemId);
          const who = item?.email ?? "the person on request " + e.itemId;
          return (
            <article key={e.requestId} className="flex flex-col gap-3 rounded-bento bg-peach/40 p-5">
              <p className="font-semibold [overflow-wrap:anywhere]">{`Erase the ${kindLabel(e.kind)} for ${who}`}</p>
              <p className="text-small text-muted">{`Proposed ${when(e.createdAt)} by ${e.proposedBy === meId ? "you" : "another administrator"}.`}</p>
              <Controls kind="erase" requestId={e.requestId} who={who} account={kindLabel(e.kind)} mine={e.proposedBy === meId} />
            </article>
          );
        })}
      </section>
      <section aria-label="Open requests" className="flex flex-col gap-3">
        <h2 className="text-[22px]">Open requests</h2>
        {items.length === 0 && <Notice kind="info">No data request is open.</Notice>}
        {truncated && <Notice kind="warning">More than 100 requests are open. The oldest 100 are shown. Close some to see the rest.</Notice>}
        {items.map((i) => (
          <article key={i.itemId} className="flex flex-col gap-3 rounded-bento bg-sand p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold [overflow-wrap:anywhere]">{i.email ?? "No email on the request"}</p>
              <Pill tone="lilac">{surfaceLabel(i.surface)}</Pill>
            </div>
            <p className="text-small text-muted">{`Received ${when(i.createdAt)}. ${i.signedIn ? "Sent while signed in." : "Sent by a visitor who was not signed in."} ${confirmText(i, when)}`}</p>
            <Controls kind="item" itemId={i.itemId} email={i.email} canPropose={canProposeErase(i)} />
          </article>
        ))}
      </section>
    </div>
  );
}
