// Frame E08: the jobs list with tabs, a table, a stats card for one job and the card that says why a job is held. Presentational (props from the reads), so a test renders each state.
// Tabs count from the one list the page read (CF128: the same rule everywhere: the number of that list's jobs in that state, "200+" at the route's cap). Previous and Next only (#125).
import { Button, EmptyState, Icon, Notice, Pager, Tabs } from "@portal/ui";
import { JobsTable, StatsCard } from "../_jobs/table";
import { SAVED, savedWord } from "../_jobform/words";
import { JOB_FORM_LIVE } from "../_site/flags";
import { countWord, dateWord, holdWord, inTab, jobState, STATE_WORD, TABS, tabKey, totals, type Job, type StatRow } from "../_jobs/words";

export const PAGE = 20;
const href = (tab: string, from = 0, job?: string) => { const p = new URLSearchParams(); if (tab !== "all") p.set("tab", tab); if (from > 0) p.set("from", String(from)); if (job) p.set("job", job); const s = p.toString(); return `/jobs${s ? `?${s}` : ""}`; };
const offset = (v: string | undefined, max: number) => (v && /^\d{1,4}$/.test(v) ? Math.min(Number(v), max) : 0);

export function JobsView({ now, role, jobs, stats, tab: tabValue, from, pick, saved }: { now: number; role: string; jobs?: Job[]; stats?: StatRow[]; tab?: string; from?: string; pick?: string; saved?: string }) {
  const canPost = role !== "viewer";
  const tab = tabKey(tabValue);
  const all = jobs ?? [];
  const shown = all.filter((j) => inTab(tab, j));
  const start = Math.floor(offset(from, Math.max(0, shown.length - 1)) / PAGE) * PAGE;
  const rows = shown.slice(start, start + PAGE);
  const sums = totals(stats ?? []);
  const isHeld = (j: Job) => ["in_review", "under_review", "hidden"].includes(jobState(j));
  const sel = all.find((j) => j.id === pick) ?? rows.find((j) => jobState(j) === "live") ?? rows[0] ?? all[0];
  const held = sel && isHeld(sel) ? sel : all.find(isHeld); // the card beside the stats: the picked job if it is held, else the first held job
  return (
    <div className="mx-auto flex max-w-page flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div><h1>Jobs</h1><p className="mt-2 text-muted">Each job is live for 30 days. We remind you before it expires.</p></div>
        {canPost && JOB_FORM_LIVE && <Button href="/jobs/new" variant="dark" size="lg"><Icon name="plus" size={18} />Post a job</Button>}
      </header>
      {saved && SAVED.includes(saved) && <Notice kind="success">{savedWord(saved, saved === "draft")}</Notice>}
      {!jobs ? <Notice kind="error" title="We cannot show your jobs now">Reload the page in a minute.</Notice> : (
        <>
          <Tabs label="Jobs by state" items={TABS.map(([key, label]) => ({ label, count: countWord(all.filter((j) => inTab(key, j)).length), href: href(key), active: key === tab }))} />
          {rows.length === 0 ? (
            <EmptyState icon="briefcase" title={all.length === 0 ? "No jobs yet" : "No jobs in this tab"} action={all.length === 0 && canPost && JOB_FORM_LIVE ? <Button href="/jobs/new">Post a job</Button> : undefined}>
              {all.length === 0 ? (canPost ? "A job you post shows here with its views and apply clicks." : "Jobs your team posts show here.") : "Pick another tab to see the rest."}
            </EmptyState>
          ) : (
            <JobsTable jobs={rows} totals={sums} now={now} canPost={canPost} detail selected={sel?.id} selectHref={(id) => href(tab, start, id)} />
          )}
          {(start > 0 || shown.length > start + PAGE) && <Pager prevHref={start > 0 ? href(tab, Math.max(0, start - PAGE)) : undefined} nextHref={shown.length > start + PAGE ? href(tab, start + PAGE) : undefined} />}
          {sel && (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
              <StatsCard title={sel.title} rows={(stats ?? []).filter((r) => r.jobId === sel.id)} now={now} />
              {held && (
                <section aria-labelledby="held-h" data-card="held" className="flex flex-col gap-3 rounded-bento bg-peach p-6">
                  <h2 id="held-h" className="flex items-start gap-3 text-xl"><Icon name="warning" size={22} />{held.title} is {STATE_WORD[jobState(held)].toLowerCase()}</h2>
                  <p>{holdWord(held, dateWord(held.closedAt ?? held.closesAt))}</p>
                  {canPost && JOB_FORM_LIVE && jobState(held) === "under_review" && <Button href={`/jobs/${held.id}/edit`} variant="dark" className="self-start">Edit the job</Button>}
                  {(jobState(held) === "hidden" || jobState(held) === "removed") && <Button href="/account-status" variant="dark" className="self-start">See why</Button>}
                </section>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
