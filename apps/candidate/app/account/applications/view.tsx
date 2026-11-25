// The applications page (frames NA2 and M07): what the candidate tracks, in columns by stage (#86: no Active and Closed tabs), then the closed ones, then the saved jobs and
// alerts at a glance. A job on the employer's own site enters only on "Yes, I applied" (#49), and its stage is moved by the candidate. #287: no handler, no on-site apply (Launch B).
import { A, Button, Icon, Notice, Pill, EmptyState } from "@portal/ui";
import { alertsPath, jobPath, permitRequestPath, savedPath } from "../../../lib/paths";
import { ago } from "../../jobs/format";
import { Logo } from "../../jobs/parts";
import { alertName, type AlertRow } from "../alerts/view";
import { AlertToggle, StageSelect, WithdrawButton } from "../client";
import { reasonText, STAGE_TEXT } from "../messages";
import { Hl } from "../../jobs/parts";
import { Head } from "../parts";

export type TrackedRow = { jobId: string; title: string; employerName: string; county?: string | null; live: boolean; reason: string | null; route: string; stage: string; updatedAt: string; employerLogoUrl?: string | null };
export type SavedBit = { jobId: string; title: string; employerName: string; county?: string | null; live: boolean; salaryLine?: string | null };

const COLUMNS = ["applied", "interview", "viewed", "shortlisted", "offer", "hired"] as const;
const WAITING = new Set(["applied", "viewed", "shortlisted", "interview"]);
/** Closed: the candidate was not selected or withdrew, or the job closed while the row was still waiting. */
export const isClosed = (r: Pick<TrackedRow, "stage" | "live">) => r.stage === "rejected" || r.stage === "withdrawn" || (!r.live && WAITING.has(r.stage));

function Card({ r, now }: { r: TrackedRow; now: Date }) {
  const when = ago(r.updatedAt, now);
  return (
    <article data-tracked={r.jobId} className="flex flex-col gap-2 rounded-card bg-white p-3.5">
      <p className="flex items-center gap-2 text-small text-muted"><Logo name={r.employerName} url={r.employerLogoUrl} className="size-9" /><span className="min-w-0 break-words">{r.employerName}</span></p>
      <h3 className="break-words text-[17px] leading-snug">{r.live ? <A href={jobPath({ id: r.jobId, title: r.title, county: r.county ?? null })} className="underline-offset-2 hover:underline">{r.title}</A> : r.title}</h3>
      <p className="flex flex-wrap gap-2">{r.route === "redirect" && <Pill tone="lilac" className="min-h-0 px-3 py-1 text-[13px]">Employer&apos;s site</Pill>}{!r.live && <Pill tone="peach" className="min-h-0 px-3 py-1 text-[13px]">{reasonText(r.reason)}</Pill>}</p>
      {when && <p className="text-small text-muted">Changed {when}</p>}
      {r.route === "redirect" ? <StageSelect jobId={r.jobId} title={r.title} stage={r.stage} /> : <p className="text-small text-muted">You cannot move this one yourself.</p>}
    </article>
  );
}

function Closed({ r }: { r: TrackedRow }) {
  const why = r.stage === "rejected" ? "Not selected" : r.stage === "withdrawn" ? "Withdrawn" : reasonText(r.reason);
  return (
    <li data-tracked={r.jobId} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
      <Logo name={r.employerName} url={r.employerLogoUrl} />
      <div className="min-w-0 flex-1 basis-48"><p className="break-words font-semibold">{r.title}</p><p className="break-words text-small text-muted">{r.employerName}</p></div>
      <Pill tone="lilac" className="min-h-0 px-3 py-1 text-[13px]">{why}</Pill>
      <span className="flex gap-2">
        {!r.live && <Button href={jobPath({ id: r.jobId, title: r.title, county: null })} variant="outline">See similar jobs</Button>}
        {r.stage !== "withdrawn" && <WithdrawButton jobId={r.jobId} />}
      </span>
    </li>
  );
}

export function ApplicationsView({ tracked, count, saved, savedCount, alerts, titleOf, now }: { tracked: TrackedRow[]; count: number; saved: SavedBit[] | null; savedCount: number; alerts: AlertRow[] | null; titleOf: (c: string) => string | undefined; now: Date }) {
  const open = tracked.filter((r) => !isClosed(r));
  const closed = tracked.filter(isClosed);
  const cols = COLUMNS.map((s) => ({ s, rows: open.filter((r) => r.stage === s) })).filter((c) => c.rows.length);
  return (
    <>
      <Head big title={<>Your <Hl c="green">applications</Hl> and <Hl c="peach">saved jobs</Hl></>} />
      <div className="mb-5"><Notice kind="info">A job you applied to on the employer&apos;s own site enters your tracker only when you tap &quot;Yes, I applied&quot;. A click alone never counts.</Notice></div>
      {tracked.length === 0 ? (
        <EmptyState icon="briefcase" title="No applications yet" action={<Button href="/jobs">Find jobs</Button>}>When you apply on an employer&apos;s site and tell us, the job appears here.</EmptyState>
      ) : (
        <>
          {count > tracked.length && <p className="mb-3 text-small text-muted">Showing the {tracked.length} most recent of {count}.</p>}
          {cols.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]">
              {cols.map((c) => (
                <section key={c.s} aria-label={STAGE_TEXT[c.s]} className="flex flex-col gap-3 rounded-bento bg-sand p-3.5">
                  <h2 className="flex items-center justify-between text-[16px]">{STAGE_TEXT[c.s]} <span className="rounded-pill bg-ink px-2 text-caption font-semibold leading-6 text-white">{c.rows.length}</span></h2>
                  {c.rows.map((r) => <Card key={r.jobId} r={r} now={now} />)}
                </section>
              ))}
            </div>
          )}
          {closed.length > 0 && (
            <section aria-labelledby="closed-h" className="mt-5 rounded-bento bg-sand p-5">
              <h2 id="closed-h" className="mb-4 text-[20px]">Closed and not selected</h2>
              <ul className="divide-y divide-line">{closed.map((r) => <Closed key={r.jobId} r={r} />)}</ul>
            </section>
          )}
        </>
      )}
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <section aria-labelledby="sv-h" className="rounded-bento bg-sand p-5">
          <h2 id="sv-h" className="mb-3 flex items-center justify-between text-[20px]">Saved jobs <Pill tone="white" className="min-h-0 px-3 py-1 text-[13px]">{savedCount} saved</Pill></h2>
          {saved === null ? <p className="text-muted">We could not load your saved jobs.</p> : saved.length === 0 ? <p className="text-muted">Tap the bookmark on a job to keep it here.</p> : (
            <ul className="divide-y divide-line">{saved.slice(0, 3).map((s) => (
              <li key={s.jobId} className="py-2.5 first:pt-0 last:pb-0"><p className="break-words font-semibold">{s.title}</p><p className="break-words text-small text-muted">{s.employerName}{s.live && s.county ? ` · ${s.county}` : ""}{!s.live ? ` · ${reasonText(null)}` : ""}</p></li>
            ))}</ul>
          )}
          <p className="mt-3"><A href={savedPath()} className="font-semibold text-deep-green underline underline-offset-2">All saved jobs</A></p>
        </section>
        <section aria-labelledby="al-h" className="rounded-bento bg-lilac p-5">
          <h2 id="al-h" className="mb-3 flex items-center justify-between text-[20px]">Job alerts <Button href={`${alertsPath()}#new-alert`} variant="dark" size="sm">+ New alert</Button></h2>
          {alerts === null ? <p>We could not load your alerts.</p> : alerts.length === 0 ? <p>No alerts yet. We email you when a job matches.</p> : (
            <ul className="divide-y divide-ink/10">{alerts.slice(0, 3).map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"><p className="min-w-0 break-words"><span className="block font-semibold">{alertName(a, titleOf)}</span><span className="text-small">{a.frequency === "daily" ? "Daily" : "Weekly"}{a.status !== "active" ? ", paused" : ""}</span></p><AlertToggle id={a.id} label={alertName(a, titleOf)} on={a.status === "active"} /></li>
            ))}</ul>
          )}
          <p className="mt-3 text-small">Every alert email has a one-click unsubscribe.</p>
        </section>
      </div>
      <section aria-labelledby="offer-h" className="mt-5 flex flex-col items-start gap-4 rounded-bento bg-ink p-6 text-white">
        <h2 id="offer-h" className="text-[22px] text-white">Got an offer? We can handle your permit</h2>
        <Button href={permitRequestPath()}>Start a permit request <Icon name="arrow" size={16} /></Button>
      </section>
    </>
  );
}
