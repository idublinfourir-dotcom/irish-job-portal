// The account home (frame NA1): greeting, three counts, the "Did you apply?" ask, the latest applications, the open permit case and the latest updates.
// #287 cuts: no "N updates since yesterday" (L27), no profile completeness (L50), no handler name or message (L61), no contact requests (Launch B).
// "New from your alerts" is left out: no existing read gives the new jobs of an alert.
import { A, Button, Icon, Pill } from "@portal/ui";
import { alertsPath, applicationsPath, casePath, noticesPath, savedPath } from "../../lib/paths";
import { ago } from "../jobs/format";
import { Hl, Logo } from "../jobs/parts";
import { DidYouApply } from "./client";
import { STAGE_TEXT, noticeText } from "./messages";
import { Head } from "./parts";

export type Prompt = { clickId: string; title: string; employerName: string; clickedAt: string };
export type Tracked = { jobId: string; title: string; employerName: string; stage: string; employerLogoUrl?: string | null };
export type Case = { id: string; status: string; decisionOutcome: string | null; permitType: string; jobTitle: string | null; employerName: string | null; payer: string | null; documentsNeeded: { code: string; label: string | null }[]; documentCount: number };
export type Update = { id: string; templateKey: string; createdAt: string; readAt: string | null };
export type HomeData = { name: string | null; saved: number | null; alerts: number | null; applications: number | null; tracked: Tracked[]; prompt: Prompt | null; permitCase: Case | null; updates: Update[] };

const CASE_TEXT: Record<string, string> = { received: "We have your request", documents_needed: "Documents needed", waiting_for_employer: "Waiting for the employer", submitted: "Submitted", decision: "A decision has been made", closed: "Closed" };
const PERMIT_TEXT: Record<string, string> = { critical_skills: "Critical Skills Employment Permit", general: "General Employment Permit" };

/** "Good morning", "Good afternoon" or "Good evening" by the hour in Ireland. */
export function greeting(now: Date) {
  const h = Number(new Intl.DateTimeFormat("en-IE", { hour: "numeric", hourCycle: "h23", timeZone: "Europe/Dublin" }).format(now));
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

const Tile = ({ href, n, label, icon, cls }: { href: string; n: number | null; label: string; icon: "bookmark" | "briefcase" | "bell"; cls: string }) => (
  <A href={href} className={`flex min-h-36 min-w-0 flex-col justify-between gap-6 rounded-bento p-4 no-underline sm:p-5 ${cls}`}>
    <span aria-hidden="true" className="grid size-10 place-items-center rounded-pill bg-white text-ink"><Icon name={icon} size={18} /></span>
    <span><span className="block font-heading text-[2.4rem] font-semibold leading-none">{n ?? "-"}</span><span className="mt-1 block break-words text-caption sm:text-body">{label}</span></span>
  </A>
);

export function HomeView({ d, now }: { d: HomeData; now: Date }) {
  const first = d.name?.split(/\s+/)[0];
  const c = d.permitCase;
  return (
    <>
      <Head
        big
        title={<>{greeting(now)}{first && <>, <Hl c="green">{first}</Hl></>}</>}
        action={<Button href="/jobs" variant="dark" size="lg">Find jobs <Icon name="arrow" size={16} /></Button>}
      />
      <div className="grid grid-cols-3 gap-3 sm:gap-4">
        <Tile href={savedPath()} n={d.saved} label="Saved jobs" icon="bookmark" cls="bg-sand text-ink" />
        <Tile href={applicationsPath()} n={d.applications} label="Applications" icon="briefcase" cls="bg-ink text-white" />
        <Tile href={alertsPath()} n={d.alerts} label="Job alerts" icon="bell" cls="bg-lilac text-ink" />
      </div>
      {d.prompt && <div className="mt-4"><DidYouApply clickId={d.prompt.clickId} jobTitle={d.prompt.title} employer={d.prompt.employerName} when={ago(d.prompt.clickedAt, now)} /></div>}
      <div className="mt-4 grid gap-4 xl:grid-cols-[1.1fr_1fr]">
        <section aria-labelledby="apps-h" className="rounded-bento bg-sand p-5">
          <h2 id="apps-h" className="mb-3 flex items-center justify-between gap-3 text-[22px]">Your applications <Button href={applicationsPath()} variant="outline" size="sm">Open tracker <Icon name="arrow" size={14} /></Button></h2>
          {d.tracked.length === 0 ? <p className="text-muted">Nothing tracked yet. When you apply on an employer&apos;s site and tell us, it shows here.</p> : (
            <ul className="divide-y divide-line">
              {d.tracked.map((t) => (
                <li key={t.jobId} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <Logo name={t.employerName} url={t.employerLogoUrl} />
                  <p className="min-w-0 flex-1"><span className="block break-words font-semibold">{t.title}</span><span className="block break-words text-small text-muted">{t.employerName}</span></p>
                  <Pill tone="lilac" className="min-h-0 px-3 py-1 text-[13px]">{STAGE_TEXT[t.stage] ?? t.stage}</Pill>
                </li>
              ))}
            </ul>
          )}
        </section>
        {c ? (
          <section aria-labelledby="case-h" className="flex flex-col gap-3 rounded-bento bg-ink p-5 text-white">
            <p className="flex items-center justify-between text-small text-white/75">{PERMIT_TEXT[c.permitType] ?? "Permit case"}<A href={casePath(c.id)} aria-label="Open your permit case" className="grid size-10 place-items-center rounded-pill bg-deep-green text-white"><Icon name="up-right" size={18} /></A></p>
            <h2 id="case-h" className="text-[24px] leading-snug text-white">{c.status === "documents_needed" ? <>Documents needed: <Hl c="green">{c.documentsNeeded.length}</Hl></> : CASE_TEXT[c.status] ?? "Your permit case"}</h2>
            {(c.jobTitle || c.employerName) && <p className="break-words text-small text-white/75">{[c.jobTitle, c.employerName].filter(Boolean).join(" at ")}</p>}
            {c.status === "documents_needed" && c.documentsNeeded.length > 0 && <ul className="list-inside list-disc text-small text-white/90">{c.documentsNeeded.map((x) => <li key={x.code}>{x.label ?? x.code}</li>)}</ul>}
            {c.payer === "employer" && <p className="text-small text-peach">Your employer is paying the fee for this application.</p>}
            <Button href={casePath(c.id)} className="mt-auto self-start">Open case <Icon name="arrow" size={16} /></Button>
          </section>
        ) : (
          <section aria-labelledby="case-h" className="flex flex-col items-start gap-3 rounded-bento bg-ink p-5 text-white">
            <h2 id="case-h" className="text-[22px] text-white">Got a job offer? We can handle your permit</h2>
            <Button href="/permit-services/request">Start a permit request <Icon name="arrow" size={16} /></Button>
          </section>
        )}
      </div>
      <section aria-labelledby="upd-h" className="mt-4 rounded-bento bg-sand p-5">
        <h2 id="upd-h" className="mb-3 flex items-center justify-between gap-3 text-[22px]">Latest updates <Button href={noticesPath()} variant="outline" size="sm">All updates <Icon name="arrow" size={14} /></Button></h2>
        {d.updates.length === 0 ? <p className="text-muted">No updates yet.</p> : (
          <ul className="divide-y divide-line">{d.updates.map((u) => (
            <li key={u.id} className="py-2.5 first:pt-0 last:pb-0"><p className="font-semibold">{noticeText(u.templateKey).title}{!u.readAt && <span className="ml-2 text-small text-deep-green">New</span>}</p></li>
          ))}</ul>
        )}
      </section>
    </>
  );
}
