// The jobs table of frames NE2 and E08 and the per-job stats card of E08: presentational, every value a prop from a read. Tables sit in their own horizontal scroll
// box, so a narrow screen scrolls the table and never the page.
import { Button, Pill, type PillTone } from "@portal/ui";
import { JOB_FORM_LIVE } from "../_site/flags";
import { JobActions } from "./actions";
import { dateWord, expiryWord, holdWord, jobState, notes, rateWord, STATE_WORD, type Job, type JobState, type StatRow } from "./words";

const TONE: Record<JobState, PillTone> = { live: "green", under_review: "peach", in_review: "lilac", draft: "outline", ended: "neutral", expired: "neutral", closed: "neutral", hidden: "white", removed: "white" };
const PERMIT: Record<string, string> = { general: "General permit", critical_skills: "Critical Skills permit" };
const th = "px-4 py-3 text-left text-small font-semibold";
const td = "px-4 py-3 align-middle";

export function StatePill({ state }: { state: JobState }) {
  if (state === "hidden" || state === "removed") return <span className="inline-flex min-h-[34px] items-center rounded-pill bg-error-tint px-3.5 text-small font-medium text-error">{STATE_WORD[state]}</span>;
  return <Pill tone={TONE[state]}>{STATE_WORD[state]}</Pill>;
}

/** `totals` has the views and apply clicks per job id (30 days); `canPost` is false for a viewer, who sees no button that writes. `detail` adds the held or closed sentence under the title. */
export function JobsTable({ jobs, totals, now, canPost, detail, selected, selectHref }: {
  jobs: readonly Job[]; totals: ReadonlyMap<string, { views: number; clicks: number }>; now: number; canPost: boolean; detail?: boolean; selected?: string; selectHref?: (id: string) => string;
}) {
  return (
    <div className="relative overflow-x-auto rounded-bento border border-line bg-sand">
      <table className="w-full min-w-[40rem] border-collapse text-small">
        <caption className="sr-only">Your jobs</caption>
        <thead className="bg-lilac">
          <tr><th scope="col" className={th}>Job</th><th scope="col" className={th}>Status</th><th scope="col" className={`${th} text-right`}>Views</th><th scope="col" className={`${th} text-right`}>Apply clicks</th><th scope="col" className={th}>Expiry</th><th scope="col" className={th}><span className="sr-only">Actions</span></th></tr>
        </thead>
        <tbody>
          {jobs.map((j) => {
            const state = jobState(j, now), t = totals.get(j.id);
            const hold = detail ? holdWord(j, dateWord(j.closedAt ?? j.closesAt), now) : null;
            return (
              <tr key={j.id} data-job={j.id} data-state={state} className={`border-t border-line ${selected === j.id ? "bg-lilac-soft" : ""}`}>
                <td className={`${td} max-w-[18rem]`}>
                  {selectHref ? <a href={selectHref(j.id)} className="font-semibold underline-offset-2 hover:underline">{j.title}</a> : <span className="font-semibold">{j.title}</span>}
                  <span className="block text-muted">{[j.county, PERMIT[j.permitType]].filter(Boolean).join(" · ")}</span>
                  {hold && <span className="mt-1 block text-muted">{hold}</span>}
                  {detail && notes(j).map((n) => <span key={n} className="block text-muted">{n}</span>)}
                </td>
                <td className={td}><StatePill state={state} /></td>
                <td className={`${td} text-right tabular-nums`}>{t?.views ?? 0}</td>
                <td className={`${td} text-right tabular-nums`}>{t?.clicks ?? 0}</td>
                <td className={`${td} text-muted`}>{expiryWord(j, now)}</td>
                <td className={td}>
                  <span className="flex flex-wrap justify-end gap-2">
                    {canPost && <JobActions id={j.id} title={j.title} state={state} />}
                    {canPost && JOB_FORM_LIVE && (state === "draft" || state === "live" || state === "in_review" || state === "under_review") && <Button href={`/jobs/${j.id}/edit`} variant="chip">Edit</Button>}
                    {canPost && JOB_FORM_LIVE && (state === "expired" || state === "closed") && <Button href={`/jobs/new?from=${j.id}`} variant="chip">Repost</Button>}
                    {(state === "hidden" || state === "removed") && <Button href="/account-status" variant="chip">See why</Button>}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const DAY = 86_400_000;
const DUBLIN_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" }); // 2026-11-25
const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "narrow", timeZone: "UTC" });
/** The last `n` Dublin days, oldest first, each with its day string and the first letter of its weekday. */
export const lastDays = (now: number, n: number) => Array.from({ length: n }, (_, i) => { const day = DUBLIN_DAY.format(now - (n - 1 - i) * DAY); return { day, letter: WEEKDAY.format(Date.parse(`${day}T12:00:00Z`)) }; });

/** Frame E08's stats card: views, apply clicks, the click rate and a bar per day for the last 7 days of one job. */
export function StatsCard({ title, rows, now }: { title: string; rows: readonly StatRow[]; now: number }) {
  const views = rows.reduce((n, r) => n + r.views, 0), clicks = rows.reduce((n, r) => n + r.applyClicks, 0);
  const days = lastDays(now, 7).map((d) => ({ ...d, views: rows.filter((r) => r.day === d.day).reduce((n, r) => n + r.views, 0) }));
  const max = Math.max(1, ...days.map((d) => d.views));
  return (
    <section aria-labelledby="stats-h" className="rounded-bento bg-sand p-6">
      <div className="flex items-baseline justify-between gap-3"><h2 id="stats-h" className="text-xl">{title} stats</h2><p className="text-small text-muted">Last 30 days</p></div>
      <dl className="mt-5 grid grid-cols-3 gap-4">
        <div><dt className="text-small text-muted">Views</dt><dd className="text-3xl font-heading">{views}</dd></div>
        <div><dt className="text-small text-muted">Apply clicks</dt><dd className="text-3xl font-heading">{clicks}</dd></div>
        <div><dt className="text-small text-muted">Click rate</dt><dd className="text-3xl font-heading">{rateWord(views, clicks)}</dd></div>
      </dl>
      <ol aria-label="Views in the last 7 days" className="mt-6 grid grid-cols-7 items-end gap-2">
        {days.map((d) => (
          <li key={d.day} className="flex flex-col items-center gap-1">
            <span className="text-small font-semibold">{d.views}</span>
            <span aria-hidden="true" className="w-full rounded-t-card bg-deep-green" style={{ height: `${Math.max(4, Math.round((d.views / max) * 96))}px` }} />
            <span className="text-small text-muted">{d.letter}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
