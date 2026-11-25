// The contact inbox (#55) as parts that take their data as props, so a test renders every state. The list shows no name, email or text: opening a message shows them
// and the route writes an audit row for the read.
import { A, EmptyState, Notice, Pager, Pill, cx } from "@portal/ui";
import { Act } from "../_queue/act";
import { ageText, when } from "../_queue/age";
import { Head } from "../_queue/page-head";
import { STATUS_LABEL, surfaceLabel, topicLabel } from "./text";

export type Summary = { id: string; status: string; topic: string; surface: string | null; createdText: string; claimedByStaffUserId: string | null; claimedText: string | null };
export type Message = Summary & {
  fromName: string | null; fromEmail: string | null; body: string; closedText: string | null; fromHeldLogin: boolean | null;
};

export const href = (id?: string, after?: string) => `/contact${new URLSearchParams({ ...(id ? { id } : {}), ...(after ? { after } : {}) }).toString().replace(/^(?=.)/, "?")}`;

export function List({ items, selected, meId, now, next, prev }: { items: Summary[]; selected?: string; meId: string; now: Date; next?: string; prev?: string }) {
  if (items.length === 0) return <EmptyState icon="help" title="No message is waiting">New messages from the contact form appear here.</EmptyState>;
  return (
    <div className="flex flex-col gap-3">
      <ul className="overflow-hidden rounded-card border border-line bg-white">
        {items.map((i) => (
          <li key={i.id} className={cx("border-b border-line last:border-b-0", i.id === selected ? "bg-lilac" : "odd:bg-sand/60")}>
            <A href={href(i.id)} aria-current={i.id === selected ? "true" : undefined} className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 no-underline">
              <span className="font-semibold">{topicLabel(i.topic)}</span>
              <span className="text-right text-small">{ageText(i.createdText, now)}</span>
              <span className="text-small text-muted">{surfaceLabel(i.surface)}</span>
              <span className="text-right">
                <Pill tone={i.status === "new" ? "peach" : "lilac"} className="min-h-[30px] px-3 text-small">{i.claimedByStaffUserId === meId ? "Yours" : (STATUS_LABEL[i.status] ?? i.status)}</Pill>
              </span>
            </A>
          </li>
        ))}
      </ul>
      {(next || prev) && <Pager prevHref={prev} nextHref={next} />}
    </div>
  );
}

export function Detail({ m, meId, canAct, now }: { m: Message; meId: string; canAct: boolean; now: Date }) {
  const here = href(m.id);
  const mine = m.claimedByStaffUserId === meId;
  const url = "/api/contact";
  const decided = m.status !== "new" && m.status !== "claimed";
  return (
    <section aria-label={`Message ${m.id}`} className="flex flex-col gap-4 rounded-card bg-sand p-5 sm:p-6 lg:rounded-bento">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-[22px]">{topicLabel(m.topic)}</h2>
        <Pill tone="peach" className="min-h-[30px]">{STATUS_LABEL[m.status] ?? m.status}</Pill>
      </header>
      <p className="text-small text-muted [overflow-wrap:anywhere]">
        From {m.fromName ?? "no name given"} · {m.fromEmail ?? "no email given"} · {surfaceLabel(m.surface)} · sent {when(m.createdText)} ({ageText(m.createdText, now)} ago)
      </p>
      {m.fromHeldLogin === true && <Notice kind="warning">This email belongs to a login that is suspended or blocked now. The sender did not prove it is theirs, so check before you reply.</Notice>}
      <p className="whitespace-pre-wrap rounded-card bg-white p-4 [overflow-wrap:anywhere]">{m.body}</p>
      {!canAct && <Notice kind="info">You can read messages. Only a services case handler or a content editor can act on one.</Notice>}
      {canAct && decided && <p className="text-small text-muted">This message is {(STATUS_LABEL[m.status] ?? m.status).toLowerCase()}{m.closedText ? ` since ${when(m.closedText)}` : ""}.</p>}
      {canAct && m.status === "new" && <Act url={url} fixed={{ action: "claim", messageId: m.id }} label="Claim this message" here={here} />}
      {canAct && m.status === "claimed" && !mine && (
        <div className="flex flex-col gap-3">
          <p className="text-small text-muted">Another staff member holds this message. A claim can be taken over after 24 hours, or when its holder is no longer active.</p>
          <Act url={url} fixed={{ action: "claim", messageId: m.id }} label="Take over the claim" here={here} />
        </div>
      )}
      {canAct && m.status === "claimed" && mine && (
        <div className="flex flex-wrap gap-4">
          <Act url={url} fixed={{ action: "answer", messageId: m.id }} label="Mark answered" here={here} confirm="Mark this message answered, once you have replied from the support mailbox?" leave="/contact" />
          <Act url={url} fixed={{ action: "close", messageId: m.id }} label="Close" variant="outline" here={here} confirm="Close this message without a reply?" leave="/contact" />
          <Act url={url} fixed={{ action: "spam", messageId: m.id }} label="Spam" variant="danger" here={here} confirm="Mark this message as spam?" leave="/contact" />
        </div>
      )}
      <p className="text-small text-muted">Nothing is sent from here: reply from the support mailbox. Opening a message and every step are written to the audit log.</p>
    </section>
  );
}

export function Contact({ items, selected, missingId, meId, canAct, now, next, prev }: { items: Summary[]; selected: Message | null; missingId?: boolean; meId: string; canAct: boolean; now: Date; next?: string; prev?: string }) {
  return (
    <div className="flex flex-col gap-6">
      <Head title="Contact messages">Messages from the contact form, oldest first. The list shows no name or text: opening a message does, and that is logged.</Head>
      {missingId && <Notice kind="warning">That message does not exist. Pick one from the list.</Notice>}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_28rem]">
        <List items={items} selected={selected?.id} meId={meId} now={now} next={next} prev={prev} />
        {selected ? <Detail m={selected} meId={meId} canAct={canAct} now={now} /> : !missingId && items.length > 0 && <Notice kind="info">Pick a message to read it.</Notice>}
      </div>
    </div>
  );
}
