// The job alerts page (frame A05): the alerts as rows (on or off, edit, delete) and the builder below. `?edit=<id>` is the address in the alert email's "Edit this alert"
// link: the same form, filled. #287: no "new this week" counts and no extras on an alert (L29). DD2: an alert paused for a Stamp 4 says so and cannot be switched on.
import { Button, Notice, Pill, EmptyState } from "@portal/ui";
import { alertsPath } from "../../../lib/paths";
import { ago, euro } from "../../jobs/format";
import { AlertForm, AlertToggle, DeleteAlert } from "../client";
import { Head } from "../parts";
import { A } from "@portal/ui";

export const ALERT_LIMIT = 10; // ALERT_LIMIT in the yaml
export type AlertRow = { id: string; occupationCode: string | null; sector: string | null; county: string | null; salaryMin: number | null; badge: string | null; frequency: string; status: string; pauseReason: string | null; lastSentAt: string | null };
const BADGE_TEXT: Record<string, string> = { sponsor_confirmed: "Sponsor confirmed only", critical_skills_eligible: "Critical Skills eligible only" };
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** The name of an alert, from its filters: "Registered nurse, Cork", "Health, all counties". */
export function alertName(a: AlertRow, titleOf: (code: string) => string | undefined) {
  const what = (a.occupationCode && titleOf(a.occupationCode)) || (a.sector && cap(a.sector)) || "All jobs";
  return `${what}, ${a.county ?? "all counties"}`;
}

function Row({ a, titleOf, now }: { a: AlertRow; titleOf: (c: string) => string | undefined; now: Date }) {
  const name = alertName(a, titleOf);
  const on = a.status === "active";
  const state = on ? null : a.status === "unsubscribed" ? "Unsubscribed" : a.pauseReason === "stamp_4" ? "Paused: Stamp 4" : "Paused";
  const sent = ago(a.lastSentAt, now);
  return (
    <li data-alert={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-bento bg-sand p-4 sm:p-5">
      <div className="min-w-0 flex-1 basis-60">
        <h2 className="break-words text-[18px] leading-snug">{name}</h2>
        <p className="mt-2 flex flex-wrap gap-2">
          {a.occupationCode && titleOf(a.occupationCode) && <Pill tone="lilac" className="min-h-0 px-3 py-1 text-[13px]">{titleOf(a.occupationCode)}</Pill>}
          {a.sector && <Pill tone="lilac" className="min-h-0 px-3 py-1 text-[13px]">{cap(a.sector)}</Pill>}
          {a.county && <Pill tone="lilac" className="min-h-0 px-3 py-1 text-[13px]">{a.county}</Pill>}
          <Pill tone="lilac" className="min-h-0 px-3 py-1 text-[13px]">{a.badge ? BADGE_TEXT[a.badge] ?? a.badge : "Both badges"}</Pill>
          {a.salaryMin !== null && <Pill tone="lilac" className="min-h-0 px-3 py-1 text-[13px]">From {euro(a.salaryMin)}</Pill>}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <p className="text-right text-small"><span className="block font-semibold">{cap(a.frequency)}</span><span className="text-muted">{state ?? (sent ? `Last email ${sent}` : "No email yet")}</span></p>
        <AlertToggle id={a.id} label={name} on={on} />
        <Button href={`${alertsPath()}?edit=${a.id}#new-alert`} variant="chip" aria-label={`Edit alert: ${name}`}>Edit</Button>
        <DeleteAlert id={a.id} label={name} />
      </div>
    </li>
  );
}

/** `edit`: the alert to edit, `"missing"` when the address named one that is not this candidate's (or gone), null for the new-alert form. */
export function AlertsView({ alerts, occupations, edit, now }: { alerts: AlertRow[]; occupations: { code: string; title: string }[]; edit: AlertRow | "missing" | null; now: Date }) {
  const titleOf = (c: string) => occupations.find((o) => o.code === c)?.title;
  const full = alerts.length >= ALERT_LIMIT;
  return (
    <>
      <Head title="Job alerts" line="We email you when a new job matches. Every email has a one-click unsubscribe." action={<Button href="#new-alert" variant="dark" size="lg"><span aria-hidden="true">+</span> New alert</Button>} />
      {alerts.some((a) => a.pauseReason === "stamp_4") && <div className="mb-4"><Notice kind="info" title="Your alerts are paused">Your profile says you hold a Stamp 4, so you no longer need a permit and we have paused them. Change your stamp in <A href="/account/profile" className="underline">your profile</A> if that is not right.</Notice></div>}
      {edit === "missing" && <div className="mb-4"><Notice kind="warning" title="That alert no longer exists">It may have been deleted. Your other alerts are below.</Notice></div>}
      {full && <div className="mb-4"><Notice kind="warning" title={`You have ${ALERT_LIMIT} alerts, the most we allow`}>Delete one to make a new one.</Notice></div>}
      {alerts.length === 0 ? <div className="mb-6"><EmptyState icon="bell" title="No alerts yet">Make one below and we email you when a job matches.</EmptyState></div> : (
        <ul className="mb-6 flex flex-col gap-3">{alerts.map((a) => <Row key={a.id} a={a} titleOf={titleOf} now={now} />)}</ul>
      )}
      <AlertForm key={edit && edit !== "missing" ? edit.id : "new"} alert={edit && edit !== "missing" ? edit : undefined} occupations={occupations} full={full} />
    </>
  );
}
