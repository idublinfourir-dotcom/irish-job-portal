// The fetched-job review queue (frame ND2) as parts that take their data as props, so a test renders every state. The page (page.tsx) reads and hands them over.
import type { DryRun, QueueItem, QueueItemDetail } from "@portal/db";
import { A, Button, CriticalSkillsBadge, EmptyState, Notice, Pager, Pill, cx } from "@portal/ui";
import { ageText, when } from "../_queue/age";
import { CheckRow } from "../_queue/tabs";
import { Actions, type SocOption } from "./actions";
import { checkRows, initials, sourceLabel, stageLabel } from "./text";

export type Counts = { total: number; stages: { stage: string | null; count: number }[] };
export const href = (o: { stage?: string; id?: string; after?: string; soc?: string; low?: number; high?: number; contract?: boolean } = {}) => {
  const p = new URLSearchParams();
  if (o.stage) p.set("stage", o.stage);
  if (o.id) p.set("id", o.id);
  if (o.after) p.set("after", o.after);
  if (o.soc) p.set("soc", o.soc);
  if (o.low !== undefined) p.set("low", String(o.low));
  if (o.high !== undefined) p.set("high", String(o.high));
  if (o.contract) p.set("contract", "1");
  const q = p.toString();
  return q ? `/fetched-jobs?${q}` : "/fetched-jobs";
};

export function Categories({ counts, stage }: { counts: Counts; stage?: string }) {
  return (
    <nav aria-label="Categories" className="flex flex-wrap gap-2">
      <Button href={href()} variant={stage === undefined ? "active" : "chip"} aria-current={stage === undefined ? "page" : undefined}>All <span className="font-semibold">{counts.total}</span></Button>
      {counts.stages.filter((s) => s.stage !== null).map((s) => (
        <Button key={s.stage} href={href({ stage: s.stage! })} variant={s.stage === stage ? "active" : "chip"} aria-current={s.stage === stage ? "page" : undefined}>
          {stageLabel(s.stage)} <span className="font-semibold">{s.count}</span>
        </Button>
      ))}
    </nav>
  );
}

export function List({ items, selected, stage, now, next, prev }: { items: QueueItem[]; selected?: string; stage?: string; now: Date; next?: string; prev?: string }) {
  if (items.length === 0) return <EmptyState icon="layers" title={stage ? "Nothing in this category" : "The queue is empty"}>Fetched jobs the rules cannot decide on their own wait here for a person.</EmptyState>;
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-bento bg-sand">
        <div aria-hidden="true" className="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_3.5rem] gap-3 bg-lilac px-4 py-3 text-small font-semibold sm:grid">
          <span>Job</span><span>Employer</span><span>Queued because</span><span className="text-right">Age</span>
        </div>
        <ul>
          {items.map((i) => (
            <li key={i.id} className={cx("border-b border-line/60 last:border-b-0", i.id === selected ? "bg-green-tint/50" : "")}>
              <A href={href({ stage, id: i.id })} aria-current={i.id === selected ? "true" : undefined} className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 no-underline sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_3.5rem]">
                <span className="font-semibold [overflow-wrap:anywhere]">{i.title}</span>
                <span className="order-2 text-right text-small sm:order-4">{ageText(i.queuedAt, now)}</span>
                <span className="order-3 flex items-center gap-2 text-small sm:order-2">
                  <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-pill bg-white text-caption font-semibold">{initials(i.employerName)}</span>
                  <span className="[overflow-wrap:anywhere]">{i.employerName}</span>
                </span>
                <span className="order-4 col-span-2 sm:order-3 sm:col-span-1"><Pill tone="lilac" className="min-h-[30px] px-3 text-small">{stageLabel(i.stage)}</Pill></span>
              </A>
            </li>
          ))}
        </ul>
      </div>
      {(next || prev) && <Pager prevHref={prev} nextHref={next} />}
    </div>
  );
}

export type DryState = { dry: DryRun | null; problem?: string };

export function Detail({ item, mine, dryState, socOptions, soc, contract, low, high, stage, now }: { item: QueueItemDetail; mine: boolean; dryState: DryState; socOptions: SocOption[]; soc: string; contract: boolean; low?: number; high?: number; stage?: string; now: Date }) {
  const { dry, problem } = dryState;
  const code = soc === "" ? undefined : soc;
  return (
    <section aria-label={`Review of ${item.title}`} className="flex flex-col gap-4 rounded-bento bg-sand p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Pill tone="lilac" className="min-h-[30px]">{stageLabel(item.stage)}</Pill>
        <p className="text-small text-muted">Fetched {when(item.queuedAt)} · waiting {ageText(item.queuedAt, now)}</p>
      </div>
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="grid size-12 shrink-0 place-items-center rounded-pill bg-white font-semibold shadow-card">{initials(item.employerName)}</span>
        <div className="min-w-0">
          <h2 className="text-[26px] [overflow-wrap:anywhere]">{item.title}</h2>
          <p className="text-small text-muted [overflow-wrap:anywhere]">
            {[item.employerName, item.county, sourceLabel(item.sourceKind)].filter(Boolean).join(" · ")}
            {item.advertUrl && <> · <a href={item.advertUrl} target="_blank" rel="noopener noreferrer nofollow" className="font-semibold text-deep-green underline underline-offset-2">Open the advert<span className="sr-only"> (new tab)</span></a></>}
          </p>
          {(item.permitHistory === "has_history" || item.wrcAgency) && (
            <p className="mt-1 flex flex-wrap gap-1.5 text-small">
              {item.permitHistory === "has_history" && <Pill tone="white" className="min-h-[28px] px-3">{item.sponsorPermits !== null ? `${item.sponsorPermits} DETE permits in 5 years` : "Has DETE permits"}</Pill>}
              {item.wrcAgency && <Pill tone="peach" className="min-h-[28px] px-3">On the agency register</Pill>}
            </p>
          )}
        </div>
      </div>
      <div>
        <p className="mb-2 font-semibold">Why it was queued: quoted evidence</p>
        <div className="rounded-bento bg-lilac p-4 text-ui">
          {item.quotedEvidence ? <blockquote className="whitespace-pre-line [overflow-wrap:anywhere]">{item.quotedEvidence}</blockquote> : <p className="text-muted">No quote was saved for this advert.</p>}
          {item.reason && <p className="mt-2 text-small text-muted [overflow-wrap:anywhere]">Rules said: {item.reason}</p>}
        </div>
        {item.advertText && (
          <details className="mt-2 text-small">
            <summary className="min-h-11 cursor-pointer py-2.5 font-semibold text-deep-green">Read the saved advert text</summary>
            <p className="max-h-80 overflow-auto whitespace-pre-wrap rounded-control bg-white p-4 text-muted [overflow-wrap:anywhere]">{item.advertText}</p>
          </details>
        )}
      </div>
      {problem && <Notice kind="warning">{problem}</Notice>}
      {dry && (
        <ul className="divide-y divide-line border-y border-line">
          {checkRows(dry).map((r) => <CheckRow key={r.title} ok={r.ok} title={r.title}>{r.text}</CheckRow>)}
        </ul>
      )}
      {!dry && !problem && <Notice kind="info">Pick a SOC code and press Check to see the rules&apos; answer for it.</Notice>}
      <Actions itemId={item.id} status={item.status} mine={mine} stage={stage} socOptions={socOptions} soc={soc} contract={contract} low={low} high={high} listHref={href({ stage })} />
      {dry && (
        <p className="flex flex-wrap items-center gap-2 text-small text-muted">
          {dry.wouldPublish ? <>With code {code} it publishes with <CriticalSkillsBadge /></> : <>With code {code} it would not publish yet: the rules stopped at &ldquo;{dry.failedStage}&rdquo;.</>}
        </p>
      )}
      <p className="text-small text-muted">Every decision is written to the audit log. Decisions are also kept as a labelled test set for checking the matcher.</p>
    </section>
  );
}

export function FetchedJobs({ items, counts, stage, selected, missingId, meId, dryState, socOptions, soc, contract, low, high, now, next, prev }: {
  items: QueueItem[]; counts: Counts; stage?: string; selected: QueueItemDetail | null; missingId?: boolean; meId: string; dryState: DryState; socOptions: SocOption[]; soc: string; contract: boolean; low?: number; high?: number; now: Date; next?: string; prev?: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="mb-1 text-[32px] leading-tight md:text-[34px]">Fetched <span className="rounded-pill bg-lilac px-3">job queue</span></h1>
        <p className="text-muted">Jobs the rules could not decide alone. Read the evidence, check the code, then publish or reject.</p>
      </header>
      <Categories counts={counts} stage={stage} />
      {missingId && <Notice kind="warning">That item is not a fetched job. Pick one from the list.</Notice>}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] xl:grid-cols-[minmax(0,1fr)_32rem]">
        <List items={items} selected={selected?.id} stage={stage} now={now} next={next} prev={prev} />
        {selected && <Detail item={selected} mine={selected.claimedBy === meId} dryState={dryState} socOptions={socOptions} soc={soc} contract={contract} low={low} high={high} stage={stage} now={now} />}
      </div>
    </div>
  );
}
