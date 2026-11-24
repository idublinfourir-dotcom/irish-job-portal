// The account review queue (frame D02) as parts that take their data as props, so a test renders every state. The page (page.tsx) reads and hands them over.
import type { ReviewCounts, ReviewItem } from "@portal/db";
import { A, EmptyState, Notice, Pager, Pill, cx } from "@portal/ui";
import { ageText, when } from "../_queue/age";
import { CheckRow, CountTabs } from "../_queue/tabs";
import { Actions } from "./actions";
import { checksOf, flagsOf, outcomeText, signedUpBy, typeLabel } from "./text";

export const TABS = [["waiting", "Waiting"], ["needs_info", "Needs more info"], ["approved", "Approved"], ["rejected", "Rejected"]] as const;
export type Tab = (typeof TABS)[number][0];
export const isTab = (v: string | undefined): v is Tab => TABS.some(([k]) => k === v);
const COUNT: Record<Tab, keyof ReviewCounts> = { waiting: "waiting", needs_info: "needsInfo", approved: "approved", rejected: "rejected" };

export const href = (tab: Tab, id?: string, after?: string) => `/account-reviews?${new URLSearchParams({ ...(tab === "waiting" ? {} : { tab }), ...(id ? { id } : {}), ...(after ? { after } : {}) })}`.replace(/\?$/, "");

const TONE = { peach: "peach", error: "peach", green: "green" } as const;

export function Flags({ item }: { item: ReviewItem }) {
  return (
    <>
      {flagsOf(item).map((f) => (
        <Pill key={f.text} tone={TONE[f.tone]} className={cx("min-h-[30px] px-3 text-small", f.tone === "error" && "bg-error-tint text-error")}>{f.text}</Pill>
      ))}
    </>
  );
}

export function List({ tab, items, selected, now, next, prev }: { tab: Tab; items: ReviewItem[]; selected?: string; now: Date; next?: string; prev?: string }) {
  const decided = tab === "approved" || tab === "rejected";
  if (items.length === 0)
    return <EmptyState icon="users" title={tab === "waiting" ? "Nothing is waiting" : tab === "needs_info" ? "No company is waiting for an answer" : `No ${tab} companies yet`}>Companies appear here as they sign up or claim a page.</EmptyState>;
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-card border border-line bg-white">
        <div aria-hidden="true" className="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1.8fr)_3rem] gap-3 border-b border-line px-4 py-3 text-small font-semibold sm:grid">
          <span>Organisation</span><span>Type</span><span>Flags</span><span className="text-right">{decided ? "Decided" : "Age"}</span>
        </div>
        <ul>
          {items.map((i) => (
            <li key={i.id} className={cx("border-b border-line last:border-b-0", i.id === selected ? "bg-lilac" : "odd:bg-sand/60")}>
              <A href={href(tab, i.id)} aria-current={i.id === selected ? "true" : undefined} className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 no-underline sm:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1.8fr)_3rem]">
                <span className="font-semibold [overflow-wrap:anywhere]">{i.displayName}</span>
                <span className="order-2 text-right text-small sm:order-4">{ageText(decided ? (i.decidedAt ?? i.createdAt) : i.createdAt, now)}</span>
                <span className="order-3 text-small text-muted sm:order-2">{typeLabel(i)}</span>
                <span className="order-4 col-span-2 flex flex-wrap gap-1.5 sm:order-3 sm:col-span-1"><Flags item={i} /></span>
              </A>
            </li>
          ))}
        </ul>
      </div>
      {(next || prev) && <Pager prevHref={prev} nextHref={next} />}
    </div>
  );
}

export function Detail({ item, mine, listHref }: { item: ReviewItem; mine: boolean; listHref: string }) {
  const decided = outcomeText(item);
  const domainOk = item.emailDomain !== null && !item.freeEmail;
  return (
    <section className="flex flex-col gap-4 rounded-card bg-sand p-5 sm:p-6 lg:rounded-bento" aria-label={`Review of ${item.displayName}`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-[22px] [overflow-wrap:anywhere]">{item.displayName}</h2>
        <Pill tone="peach" className="min-h-[30px]">{typeLabel(item)}</Pill>
      </header>
      <p className="text-small text-muted [overflow-wrap:anywhere]">{signedUpBy(item)} · {when(item.createdAt)}</p>
      {item.organisationStatus === "needs_info" && item.status !== "done" && <Notice kind="info">Waiting for the company&apos;s answer to your question.</Notice>}
      {item.answer && (
        <Notice kind="success" title={`The company answered${item.answeredAt ? ` on ${when(item.answeredAt)}` : ""}`}>
          <span className="whitespace-pre-line [overflow-wrap:anywhere]">{item.answer}</span>
        </Notice>
      )}
      <ul className="divide-y divide-line border-y border-line">
        {checksOf(item).map((c) => <CheckRow key={c.title} ok={c.ok} title={c.title}>{c.text}</CheckRow>)}
      </ul>
      {decided && item.status === "done" && <Notice kind={item.outcome === "approved" ? "success" : "info"} title={`${decided}${item.decidedAt ? ` on ${when(item.decidedAt)}` : ""}`} />}
      <Actions itemId={item.id} status={item.status} mine={mine} emailDomain={item.emailDomain} canAddDomain={domainOk} companyName={item.displayName} listHref={listHref} />
    </section>
  );
}

/** The whole page body for a reviewer. `selected` is the item whose detail shows (null: none, or the id given is not an account review). */
export function AccountReviews({ tab, items, counts, selected, missingId, meId, now, next, prev }: { tab: Tab; items: ReviewItem[]; counts: ReviewCounts; selected: ReviewItem | null; missingId?: boolean; meId: string; now: Date; next?: string; prev?: string }) {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="mb-1 text-[32px] leading-tight md:text-[34px]">Account reviews</h1>
        <p className="text-muted">Companies and agencies waiting for a decision before they can post.</p>
      </header>
      <CountTabs label="Account review tabs" items={TABS.map(([k, label]) => ({ label, count: counts[COUNT[k]], href: href(k), active: k === tab }))} />
      {missingId && <Notice kind="warning">That item is not an account review. Pick one from the list.</Notice>}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_26rem]">
        <List tab={tab} items={items} selected={selected?.id} now={now} next={next} prev={prev} />
        {selected && <Detail item={selected} mine={selected.claimedBy === meId} listHref={href(tab)} />}
      </div>
    </div>
  );
}
