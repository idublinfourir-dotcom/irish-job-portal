// Frame NE2: the employer dashboard. Presentational: every value arrives as a prop from a read, so a test renders every state. The frame's applicant card, the
// "New applicants" tile and the "Hire recorded" tile are Launch B or dropped (#287, L56); the third tile is "Apply clicks" (CF70). Photos are left out (frame NS6).
import type { ReactNode } from "react";
import { A, Button, EmptyState, Icon, Notice, Pill } from "@portal/ui";
import { JobActions, NotRecognisedButton, ReportButton } from "../_jobs/actions";
import { JobsTable } from "../_jobs/table";
import { JOB_FORM_LIVE } from "../_site/flags";
import { dateWord, daysLeft, daysWord, EXPIRING_DAYS, greeting, jobState, roleWord, totals, type Job, type StatRow } from "../_jobs/words";

export type StatusPage = { status: string; strikesLast12Months: number; restrictedUntil: string | null; cases: { canReply: boolean; canAppeal: boolean }[] };
export type Team = { myMembershipId: string; members: { membershipId: string; name: string | null; email: string; role: string; isSigner: boolean }[] };
export type AgencyJob = { id: string; title: string; agencyName: string; status: string; postedAt: string };

const COMPANY_WORD: Record<string, string> = {
  verified: "Verified", verified_restricted: "Restricted", pending_review: "In review", needs_info: "Needs more information", suspended: "Suspended", closed: "Closed", rejected: "Not approved", banned: "Not active",
};
const COMPANY_LINE: Record<string, string> = {
  verified: "Your company is verified and can post jobs.", verified_restricted: "A new job is checked by our staff before it goes live.", suspended: "Your jobs are hidden while we look into it.",
  closed: "Your company account is closed. Nothing new can be posted.", needs_info: "We asked for more information. Open Verification to answer.", pending_review: "Our team is checking your company.",
};

const tile = "flex min-h-44 flex-col justify-between rounded-bento p-6";
function Tile({ n, label, tone, icon }: { n: ReactNode; label: string; tone: string; icon: "briefcase" | "eye" | "pulse" | "clock" }) {
  return (
    <div data-tile={label} className={`${tile} ${tone}`}>
      <span aria-hidden="true" className="grid size-10 place-items-center rounded-pill bg-white text-ink"><Icon name={icon} size={20} /></span>
      <p><span className="block font-heading text-5xl tabular-nums">{n}</span><span className="text-lead">{label}</span></p>
    </div>
  );
}

/** Jobs that need attention first on the dashboard (live, held, then the rest); the sort keeps the list's newest-first order inside a group. */
const rank = (j: Job) => (jobState(j) === "live" ? 0 : ["under_review", "in_review", "draft"].includes(jobState(j)) ? 1 : 2);
const Unavailable = ({ what }: { what: string }) => <Notice kind="warning" title={`${what} cannot be shown now`}>Reload the page in a minute.</Notice>;

export function DashboardView({ now, role, jobs, stats, status, team, teamOk, agency }: {
  now: number; role: string; jobs?: Job[]; stats?: StatRow[]; status?: StatusPage; team: Team | null; teamOk: boolean; agency?: AgencyJob[];
}) {
  const canPost = role !== "viewer", owner = role === "account_owner";
  const sums = totals(stats ?? []);
  const live = (jobs ?? []).filter((j) => jobState(j) === "live");
  const held = (jobs ?? []).filter((j) => ["in_review", "under_review"].includes(jobState(j))).length;
  const views = [...sums.values()].reduce((n, t) => n + t.views, 0), clicks = [...sums.values()].reduce((n, t) => n + t.clicks, 0);
  const ending = live.map((j) => ({ j, n: daysLeft(j.closesAt, now) })).filter((x): x is { j: Job; n: number } => x.n !== null && x.n <= EXPIRING_DAYS).sort((a, b) => a.n - b.n)[0];
  const me = team?.members.find((m) => m.membershipId === team.myMembershipId)?.name?.split(/\s+/)[0];
  const needsYou = (status?.cases ?? []).some((c) => c.canReply || c.canAppeal);
  const link = "inline-flex min-h-11 items-center gap-1 font-semibold text-deep-green underline-offset-2 hover:underline";
  return (
    <div className="mx-auto flex max-w-page flex-col gap-6">
      <header>
        <h1>{greeting(now)}{me ? <>, <span className="rounded-pill bg-deep-green px-3 text-white">{me}</span></> : ""}</h1>
        {jobs && <p className="mt-2 text-lead text-muted" data-live-count>{live.length === 0 ? "You have no live jobs." : `${live.length} live ${live.length === 1 ? "job" : "jobs"} right now.`}</p>}
      </header>

      {ending && (
        <section aria-label="A job ends soon" className="flex flex-wrap items-center justify-between gap-4 rounded-bento bg-peach p-5">
          <p className="flex items-center gap-3"><Icon name="clock" size={22} /><span><span className="block font-semibold">{ending.j.title} {ending.n <= 0 ? "ends today" : `ends in ${daysWord(ending.n).replace(" left", "")}`}</span><span className="text-small">Renew in one click, or close it and tell us if you hired.</span></span></p>
          {canPost ? <span className="flex gap-2"><JobActions id={ending.j.id} title={ending.j.title} state="live" /></span> : <span className="text-small">Ask a poster or the account owner to renew it.</span>}
        </section>
      )}

      {jobs ? (
        <section aria-label="Your numbers" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Tile n={live.length} label="Live jobs" tone="bg-sand" icon="briefcase" />
          <Tile n={views} label="Job views, 30 days" tone="bg-lilac" icon="eye" />
          <Tile n={clicks} label="Apply clicks, 30 days" tone="bg-ink text-white" icon="pulse" />
          <Tile n={held} label="Held for a check" tone="bg-ink text-white" icon="clock" />
        </section>
      ) : <Unavailable what="Your jobs" />}

      <section aria-labelledby="jobs-h" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3"><h2 id="jobs-h" className="text-xl">Your jobs</h2><A href="/jobs" className={link}>All jobs <Icon name="arrow" size={16} /></A></div>
        {!jobs ? <Unavailable what="The jobs list" /> : jobs.length === 0 ? (
          <EmptyState icon="briefcase" title="No jobs yet" action={canPost && JOB_FORM_LIVE ? <Button href="/jobs/new">Post a job</Button> : undefined}>{canPost ? "A job you post shows here with its views and apply clicks." : "Jobs your team posts show here."}</EmptyState>
        ) : <JobsTable jobs={[...jobs].sort((a, b) => rank(a) - rank(b)).slice(0, 5)} totals={sums} now={now} canPost={canPost} />}
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="flex flex-col gap-3 rounded-bento bg-sand p-6" aria-labelledby="acct-h" data-card="account-status">
          <div className="flex items-center justify-between gap-2"><h2 id="acct-h" className="text-xl">Account status</h2>{status && <Pill tone="lilac">{COMPANY_WORD[status.status] ?? "Active"}</Pill>}</div>
          {!status ? <p className="text-muted">The account status cannot be shown now.</p> : (
            <>
              <p className="text-muted">{COMPANY_LINE[status.status] ?? "Open Account status for the details."}</p>
              <p>{status.strikesLast12Months === 0 ? "No strikes in the last 12 months." : `${status.strikesLast12Months} ${status.strikesLast12Months === 1 ? "strike" : "strikes"} in the last 12 months.`}</p>
              {status.restrictedUntil && <p className="text-small text-muted">Restricted until {dateWord(status.restrictedUntil)}.</p>}
              {needsYou && <Notice kind="warning">A case about your company needs your reply or can be appealed.</Notice>}
            </>
          )}
          <A href="/account-status" className={link}>Open Account status <Icon name="arrow" size={16} /></A>
          {canPost && <A href="/pay-floors" className={link}>Pay floors for big companies <Icon name="arrow" size={16} /></A>}
        </section>

        <section className="flex flex-col gap-3 rounded-bento bg-lilac p-6" aria-labelledby="team-h" data-card="team">
          <div className="flex items-center justify-between gap-2"><h2 id="team-h" className="text-xl">Team</h2>{owner && <Button href="/team" variant="dark" size="sm">Invite</Button>}</div>
          {!teamOk ? <p>The team cannot be shown now.</p> : (
            <ul className="flex flex-col gap-2">
              {(team?.members ?? []).slice(0, 5).map((m) => <li key={m.membershipId}><span className="block font-semibold">{m.name ?? m.email}</span><span className="text-small">{roleWord(m.role)}{m.isSigner ? " · can sign" : ""}</span></li>)}
            </ul>
          )}
          <A href="/team" className={link}>Open Team <Icon name="arrow" size={16} /></A>
        </section>

        <section className="flex flex-col gap-3 rounded-bento bg-ink p-6 text-white" aria-labelledby="svc-h" data-card="services">
          <h2 id="svc-h" className="text-xl text-white">Hired someone? We handle the permit</h2>
          <p className="text-white/80">Employment permit application handling and Labour Market Needs Test guidance. The first consultation is free.</p>
          {role === "account_owner" || role === "recruiter" ? <Button href="/services" variant="sun" className="self-start">Request permit services</Button> : <p className="text-small text-white/70">The account owner or a recruiter can request permit services.</p>}
        </section>
      </div>

      <section aria-labelledby="agency-h" className="flex flex-col gap-3" data-card="agency-jobs">
        <h2 id="agency-h" className="text-xl">Jobs posted for you by agencies</h2>
        {!agency ? <Unavailable what="The agency jobs list" /> : agency.length === 0 ? <p className="text-muted">No agency has posted a job for your company.</p> : (
          <>
            <p className="text-muted">These agency jobs name your company as the employer. If you do not recognise one, say so and we hide it and check it.</p>
            <ul className="flex flex-col gap-2">
              {agency.map((a) => (
                <li key={a.id} data-agency-job={a.id} className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-sand p-4">
                  <span><span className="block font-semibold">{a.title}</span><span className="text-small text-muted">{a.agencyName} · {a.status === "live" ? "Live" : "Under review"} · posted {dateWord(a.postedAt)}</span></span>
                  <span className="flex flex-wrap gap-2"><ReportButton kind="job" id={a.id} />{owner && <NotRecognisedButton id={a.id} />}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
