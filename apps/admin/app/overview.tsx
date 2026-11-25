// The staff overview (frame ND1) as parts that take their data as props, so a test renders every role. Nothing here reads: a part shows only what the page was given,
// and the page asks only for what the member's roles may read. No pipelines card (#287, Q76).
import type { AuditRow } from "@portal/db";
import type { readCounts } from "../lib/data";
import { A, Button, EmptyState, Icon, cx, type IconName } from "@portal/ui";
import { ageSeconds, ageText, clock, today } from "./_queue/age";
import { auditInitials, auditSentence } from "./_queue/audit-text";

type StaffCounts = Awaited<ReturnType<typeof readCounts>>;
export type Tile = { key: string; icon: IconName; value: number; label: string; note?: string; href?: string; tone: "sand" | "lilac" | "peach" | "ink" };
export type Work = { key: string; title: string; queue: string; why: string; since: string; href: string };
export type Upcoming = { kinds: string[]; from: string };

const NOTE_AGE = (s: number | undefined) => (s === undefined ? undefined : `oldest ${ageSeconds(s)}`);

/** The tiles this member's counts give: a count the roles do not cover is null, so there is no tile; a queue the member works but that is empty counts 0. Order of the frame, then the administrator's two. */
export function tilesOf(c: StaffCounts, roles: readonly string[], overdue: { count: number; more: boolean } | null): Tile[] {
  const t: Tile[] = [];
  if (roles.includes("account_reviewer")) t.push({ key: "account", icon: "users", value: c.queues.account_review ?? 0, label: "Account reviews", note: NOTE_AGE(c.oldestSeconds.account_review), href: "/account-reviews", tone: "sand" });
  if (roles.includes("fetched_job_reviewer")) t.push({ key: "fetched", icon: "layers", value: c.queues.fetched_job ?? 0, label: "Fetched jobs", note: NOTE_AGE(c.oldestSeconds.fetched_job), href: "/fetched-jobs", tone: "lilac" });
  if (c.reportsOpen !== null) t.push({ key: "reports", icon: "flag", value: c.reportsOpen, label: "Reports", note: c.reportsJobHidden ? `${c.reportsJobHidden} job hidden` : undefined, href: "/reports", tone: "peach" });
  if (c.casesOpen !== null) t.push({ key: "services", icon: "file", value: c.casesOpen, label: "Services cases", note: c.casesMine !== null ? `${c.casesMine} on us` : undefined, href: "/services", tone: "ink" });
  if (c.mergeSuggestions !== null) t.push({ key: "merges", icon: "copy", value: c.mergeSuggestions, label: "Name merges suggested", href: "/name-merges", tone: "ink" });
  if (c.approvals !== null) t.push({ key: "approvals", icon: "lock", value: c.approvals, label: "Waiting for a second person", tone: "sand" });
  if (overdue) t.push({ key: "overdue", icon: "clock", value: overdue.count, label: overdue.more ? "Items over a working day old, or more" : "Items over a working day old", tone: "sand" });
  return t;
}

const TONE: Record<Tile["tone"], string> = { sand: "bg-sand text-ink", lilac: "bg-lilac text-ink", peach: "bg-peach text-ink", ink: "bg-ink text-white" };
const ICON: Record<Tile["tone"], string> = { sand: "bg-deep-green text-white", lilac: "bg-white text-ink", peach: "bg-white text-ink", ink: "bg-white text-ink" };

export function Tiles({ tiles }: { tiles: Tile[] }) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {tiles.map((t) => {
        const body = (
          <>
            <span aria-hidden="true" className={cx("grid size-10 place-items-center rounded-pill", ICON[t.tone])}><Icon name={t.icon} size={20} /></span>
            <span className="mt-5 block font-heading text-[44px] font-semibold leading-none tracking-tight">{t.value}</span>
            <span className={cx("mt-3 block text-small", t.tone === "ink" ? "text-white/80" : "text-muted")}>{t.label}{t.note ? ` · ${t.note}` : ""}</span>
          </>
        );
        return (
          <li key={t.key} data-tile={t.key}>
            {t.href ? <A href={t.href} className={cx("block min-h-32 rounded-bento p-5 no-underline sm:min-h-40", TONE[t.tone])}>{body}</A> : <div className={cx("min-h-32 rounded-bento p-5 sm:min-h-40", TONE[t.tone])}>{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}

export function WorkTable({ rows, now }: { rows: Work[]; now: Date }) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="work-h" className="overflow-hidden rounded-bento bg-sand">
      <h2 id="work-h" className="sr-only">Oldest waiting items</h2>
      <div aria-hidden="true" className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.3fr)_3.5rem_5rem] gap-3 bg-lilac px-5 py-3 text-small font-semibold md:grid">
        <span>Item</span><span>Queue</span><span>Why it is here</span><span className="text-right">Age</span><span />
      </div>
      <ul>
        {rows.map((r) => (
          <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-line/60 px-5 py-3 last:border-b-0 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.3fr)_3.5rem_5rem]">
            <span className="font-semibold [overflow-wrap:anywhere]">{r.title}</span>
            <span className="order-2 text-right text-small md:order-4">{ageText(r.since, now)}</span>
            <span className="order-3 text-small text-muted md:order-2 md:text-ink">{r.queue}</span>
            <span className="order-4 col-span-2 md:order-3 md:col-span-1"><span className="inline-block rounded-pill bg-lilac px-3 py-1 text-small [overflow-wrap:anywhere]">{r.why}</span></span>
            <span className="order-5 col-span-2 md:col-span-1"><Button href={r.href} variant="outline" size="sm" className="mt-1 md:mt-0">Open<span className="sr-only">{`: ${r.title}`}</span></Button></span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AuditLatest({ rows, full }: { rows: AuditRow[]; full: boolean }) {
  return (
    <section aria-labelledby="audit-h" className="rounded-bento bg-sand p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
        <h2 id="audit-h" className="text-[24px]">Audit log, latest</h2>
        <Button href="/audit" variant="outline" size="sm">Full log<Icon name="arrow" size={16} /></Button>
      </div>
      {rows.length === 0 ? (
        <p className="py-6 text-muted">{full ? "Nothing has been logged yet." : "Nothing of yours has been logged yet."}</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 py-3.5">
              <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-pill bg-lilac text-small font-semibold">{auditInitials(r.actor.staffName)}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold [overflow-wrap:anywhere]">{r.actor.staffName ?? r.actor.system ?? "Someone"} {auditSentence(r.action)}</span>
                {r.objectLabel && <span className="block text-small text-muted [overflow-wrap:anywhere]">{r.objectLabel}</span>}
              </span>
              <time dateTime={r.at} className="shrink-0 text-small text-muted">{clock(r.at)}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const KIND: Record<string, string> = {
  minimums: "the salary minimums", critical_skills_list: "the Critical Skills list", ineligible_list: "the ineligible list", public_pay_employers: "the public pay employers",
  big_company_names: "the big-company list", pay_scales: "the public pay scales",
};
const DATE = new Intl.DateTimeFormat("en-IE", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
export const kindWords = (kinds: string[]) => kinds.map((k) => KIND[k] ?? k.replaceAll("_", " ")).join(", ").replace(/, ([^,]*)$/, " and $1");

/** The rules notice: shown only when a confirmed version starts on a later day (the date and the kinds are read; nothing is typed in). */
export function RulesNotice({ upcoming }: { upcoming: Upcoming | null }) {
  if (!upcoming) return null;
  return (
    <section aria-labelledby="rules-h" className="rounded-bento bg-peach p-5 sm:p-6">
      <h2 id="rules-h" className="text-[22px]">{`Rules change on ${DATE.format(new Date(`${upcoming.from}T00:00:00Z`))}`}</h2>
      <p className="mt-2 text-small">{`A new version of ${kindWords(upcoming.kinds)} starts that day. Check the values in rules data before then.`}</p>
      <Button href="/rules" variant="dark" className="mt-4">Open rules data</Button>
    </section>
  );
}

export function Targets() {
  return (
    <>
      <section aria-label="Badge accuracy target" className="rounded-bento bg-sand p-5 sm:p-6">
        <p className="text-small text-muted">Target · Badge accuracy</p>
        <p className="mt-2 font-heading text-[26px] font-semibold tracking-tight">98% or more</p>
        <p className="mt-2 text-small text-muted">Monthly check of 100 live jobs</p>
      </section>
      <section aria-label="Takedown speed target" className="rounded-bento bg-lilac p-5 sm:p-6">
        <p className="text-small text-muted">Target · Takedown speed</p>
        <p className="mt-2 font-heading text-[26px] font-semibold tracking-tight">Within 24 hours</p>
        <p className="mt-2 text-small text-muted">Closed jobs and reported scams</p>
      </section>
    </>
  );
}

/** The page body. `empty` says why there is no tile: a login with no role, or roles with no queue. */
export function Overview({ now, tiles, work, audit, auditFull, upcoming, roleCount }: { now: Date; tiles: Tile[]; work: Work[]; audit: AuditRow[]; auditFull: boolean; upcoming: Upcoming | null; roleCount: number }) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <h1 className="mb-1 text-[32px] leading-tight md:text-[34px]">Queues <span className="inline-block rounded-[0.28em] bg-deep-green px-[0.22em] text-white">overview</span></h1>
        <p className="text-small text-muted">{today(now)} · target: every queue cleared within 1 working day</p>
      </header>
      {tiles.length > 0 ? <Tiles tiles={tiles} /> : (
        <EmptyState icon="shield" title={roleCount === 0 ? "Your login has no role yet" : "Your roles have no queue here"}>
          {roleCount === 0 ? "Ask an administrator to give you a role. Until then you can search, read the rules data and read your own audit rows." : "Your work is in the pages listed on the left. The audit log and the targets are below."}
        </EmptyState>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <WorkTable rows={work} now={now} />
          <AuditLatest rows={audit} full={auditFull} />
        </div>
        <div className="flex flex-col gap-6">
          <RulesNotice upcoming={upcoming} />
          <Targets />
        </div>
      </div>
    </div>
  );
}
