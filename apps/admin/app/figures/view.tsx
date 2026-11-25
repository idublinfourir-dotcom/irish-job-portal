// The read-only figures (no frame), one page, each block its own part that takes its data as props. A block is `null` when its own read refused the signed-in roles:
// then it is not drawn at all. The blocks and who reads them (docs/openapi/admin.yaml): sign-up "no" counts and permit rises (any staff), launch targets (any role),
// overdue list (administrators), scheduled checks (rules data editors, fetched job reviewers, administrators), accuracy sample (fetched job reviewers, rules data editors,
// trust and safety, administrators), decisions export (fetched job reviewers, rules data editors, administrators).
import { A, EmptyState, Notice, Pager, Pill } from "@portal/ui";
import { ageText, when } from "../_tools/text";
import { DoneButton } from "./done-button";
import { dayText, num, queueText, reminderText, safeLink, TARGETS } from "./text";

type Id = string;
export type Signup = { day: string; count: number }[];
export type Rises = { deteName: string; year: number; before: number; after: number; organisation: string | null; foundAt: Date | string }[];
export type Targets = Record<string, number | null>;
export type Overdue = { before: string; items: { id: Id; queue: string; status: string; claimed_by: string | null; created_at: string }[]; truncated: boolean; approvals: { id: Id; kind: string; target_table: string; created_at: string }[]; approvalsTruncated: boolean };
export type Checks = { items: { id: Id; reason: string; detail: Record<string, string | undefined>; status: string; created_at: string }[]; truncated: boolean };
export type Sample = { key: string | null; createdAt: string | null; jobs: { id: Id; title: string; employerName: string; sourceUrl: string | null; source: string; badge: string | null; permitType: string; passRoute: string | null; occupationCode: string | null; salaryLow: number | null; salaryHigh: number | null; stage: string | null; reason: string | null; quotedEvidence: string | null; approvedByYou: boolean }[] };
export type Decisions = { next: Id | null; items: { itemId: Id; label: string; reasonCode: string | null; decidedAt: string; title: string; employerName: string; county: string | null; occupationCode: string | null; stage: string | null }[] };
export type Blocks = { signup: Signup | null; rises: Rises | null; targets: Targets | null; overdue: Overdue | null; checks: Checks | null; sample: Sample | null; decisions: Decisions | null };

const Block = ({ id, title, note, children }: { id: string; title: string; note?: string; children: React.ReactNode }) => (
  <section id={id} aria-label={title} className="flex flex-col gap-3 rounded-bento bg-sand p-5 sm:p-6">
    <div>
      <h2 className="text-[22px]">{title}</h2>
      {note && <p className="text-small text-muted">{note}</p>}
    </div>
    {children}
  </section>
);
const Table = ({ head, children }: { head: string[]; children: React.ReactNode }) => (
  <div className="relative overflow-x-auto">
    <table className="w-full min-w-[34rem] border-collapse text-left text-small">
      <thead><tr className="bg-lilac">{head.map((h) => <th key={h} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
      <tbody className="[&_td]:border-b [&_td]:border-line/60 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_td]:[overflow-wrap:anywhere]">{children}</tbody>
    </table>
  </div>
);
const pay = (lo: number | null, hi: number | null) => (lo === null && hi === null ? "Not stated" : lo === null || hi === null || lo === hi ? `€${num((lo ?? hi)!)}` : `€${num(lo)} to €${num(hi)}`);

export function SignupBlock({ d }: { d: Signup }) {
  const shown = d.slice(0, 30);
  return (
    <Block id="signup-no" title={'Sign-ups who answered "no" to needing a permit'} note="One count a day, newest first. The table holds a date and a number, nothing about any visitor.">
      {shown.length === 0 ? <p className="text-muted">No sign-up has answered no yet.</p> : (
        <>
          <p className="font-semibold">{`${num(shown.reduce((n, x) => n + x.count, 0))} in the last ${shown.length} days shown`}</p>
          <Table head={["Day", "Count"]}>{shown.map((x) => <tr key={x.day}><td>{dayText(x.day)}</td><td>{num(x.count)}</td></tr>)}</Table>
        </>
      )}
    </Block>
  );
}

export function RisesBlock({ d }: { d: Rises }) {
  return (
    <Block id="permit-rises" title="Permit rises in the newest DETE import" note="DETE names whose permit count went up, biggest rise first, at most 200.">
      {d.length === 0 ? <p className="text-muted">No name rose in the newest import.</p> : (
        <Table head={["DETE name", "Year", "Before", "After", "Linked company", "Found"]}>
          {d.map((r) => <tr key={`${r.deteName}-${r.year}`}><td>{r.deteName}</td><td>{r.year}</td><td>{num(r.before)}</td><td>{num(r.after)}</td><td>{r.organisation ?? "Not linked"}</td><td>{when(new Date(r.foundAt).toISOString())}</td></tr>)}
        </Table>
      )}
    </Block>
  );
}

export function TargetsBlock({ d }: { d: Targets }) {
  return (
    <Block id="targets" title="Launch target counts" note="Counts only, never a person or a job.">
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {TARGETS.map(([k, label]) => (
          <div key={k} className="rounded-control bg-white p-4">
            <dt className="text-small text-muted">{label}</dt>
            <dd className="text-[26px] font-semibold">{d[k] === null || d[k] === undefined ? "No live job" : num(d[k]!)}</dd>
          </div>
        ))}
      </dl>
    </Block>
  );
}

export function OverdueBlock({ d, now }: { d: Overdue; now: Date }) {
  const none = d.items.length === 0 && d.approvals.length === 0;
  return (
    <Block id="overdue" title="Overdue" note={`Open items older than one working day (Monday to Friday, Irish time), as of ${when(d.before)}.`}>
      {none && <p className="text-muted">Nothing is overdue.</p>}
      {d.items.length > 0 && (
        <Table head={["Queue", "State", "Waiting"]}>{d.items.map((i) => <tr key={i.id}><td>{queueText(i.queue)}</td><td>{i.claimed_by ? "Held by a reviewer" : "Nobody has it"}</td><td>{ageText(i.created_at, now)}</td></tr>)}</Table>
      )}
      {d.truncated && <Notice kind="warning">More items are overdue than the list holds.</Notice>}
      {d.approvals.length > 0 && (
        <>
          <p className="font-semibold">Changes waiting for a second person</p>
          <Table head={["Change", "On", "Waiting"]}>{d.approvals.map((a) => <tr key={a.id}><td>{queueText(a.kind)}</td><td>{queueText(a.target_table)}</td><td>{ageText(a.created_at, now)}</td></tr>)}</Table>
        </>
      )}
      {d.approvalsTruncated && <Notice kind="warning">More changes are waiting than the list holds.</Notice>}
    </Block>
  );
}

export function ChecksBlock({ d }: { d: Checks }) {
  return (
    <Block id="scheduled-checks" title="Scheduled checks" note="Reminders for the roles you hold, written each day.">
      {d.items.length === 0 ? <p className="text-muted">No reminder is open.</p> : (
        <ul className="flex flex-col gap-3">
          {d.items.map((c) => {
            const link = safeLink(c.detail.address);
            return (
              <li key={c.id} className="flex flex-col gap-1 rounded-control bg-white p-4">
                <p className="font-semibold">{reminderText(c.reason)}{c.status === "claimed" && <> <Pill tone="lilac">Held</Pill></>}</p>
                <p className="text-small text-muted [overflow-wrap:anywhere]">
                  {[c.detail.name, c.detail.reviewOn && `review on ${c.detail.reviewOn}`, c.detail.failure, `opened ${when(c.created_at)}`].filter(Boolean).join(" · ")}
                  {link && <> · <A href={link} target="_blank" rel="noopener noreferrer nofollow">Open the page<span className="sr-only"> (new tab)</span></A></>}
                </p>
                {c.detail.newTitles && <p className="text-small [overflow-wrap:anywhere]">{`New: ${c.detail.newTitles}`}</p>}
                <DoneButton itemId={c.id} />
              </li>
            );
          })}
        </ul>
      )}
      {d.truncated && <Notice kind="warning">More reminders are open than the list holds.</Notice>}
    </Block>
  );
}

export function SampleBlock({ d }: { d: Sample }) {
  return (
    <Block id="accuracy-sample" title="Accuracy sample, hand check" note={d.createdAt ? `This month's random live jobs, made ${when(d.createdAt)}. Open each advert and check the badge by hand. The same jobs show on every reload.` : undefined}>
      {d.jobs.length === 0 ? <p className="text-muted">No live job yet, so no sample was made.</p> : (
        <Table head={["Job", "Badge", "Code and pay", "Fetcher said", "Advert"]}>
          {d.jobs.map((j) => (
            <tr key={j.id}>
              <td><span className="font-semibold">{j.title}</span><br />{j.employerName}{j.approvedByYou && <><br /><Pill tone="peach">You approved it: ask someone else to check</Pill></>}</td>
              <td>{j.badge ? j.badge.replaceAll("_", " ") : "No badge"}<br />{j.permitType === "critical_skills" ? "Critical Skills" : "General"}{j.passRoute && <><br />{j.passRoute.replaceAll("_", " ")}</>}</td>
              <td>{`${j.occupationCode ?? "No code"} · ${pay(j.salaryLow, j.salaryHigh)}`}</td>
              <td>{j.stage ?? "No stage"}{j.reason && <><br />{j.reason}</>}{j.quotedEvidence && <details><summary className="cursor-pointer font-semibold text-deep-green">Quoted evidence</summary>{j.quotedEvidence}</details>}</td>
              <td>{safeLink(j.sourceUrl ?? undefined) ? <A href={j.sourceUrl!} target="_blank" rel="noopener noreferrer nofollow">Open<span className="sr-only"> the advert (new tab)</span></A> : "No link"}</td>
            </tr>
          ))}
        </Table>
      )}
    </Block>
  );
}

export function DecisionsBlock({ d, prev }: { d: Decisions; prev?: string }) {
  return (
    <Block id="decisions" title="Fetched-job decisions" note="Each decision of the fetched-job queue as a labelled row for the matcher test set, oldest first, 50 a page. The advert text is in the file from the route, not on this page.">
      {d.items.length === 0 ? <EmptyState icon="layers" title="No decision here">Decided fetched jobs are listed here.</EmptyState> : (
        <Table head={["Decided", "Label", "Job", "Code", "Fetcher stage"]}>
          {d.items.map((r) => (
            <tr key={r.itemId}>
              <td>{when(r.decidedAt)}</td>
              <td>{r.label === "approved" ? "Approved" : "Rejected"}{r.reasonCode && <><br />{r.reasonCode.replaceAll("_", " ")}</>}</td>
              <td><span className="font-semibold">{r.title}</span><br />{[r.employerName, r.county].filter(Boolean).join(" · ")}</td>
              <td>{r.occupationCode ?? "None"}</td>
              <td>{r.stage ?? "No stage"}</td>
            </tr>
          ))}
        </Table>
      )}
      {(d.next || prev) && <Pager prevHref={prev} nextHref={d.next ? `/figures?after=${encodeURIComponent(d.next)}#decisions` : undefined} />}
    </Block>
  );
}

export function Figures({ b, now, prev }: { b: Blocks; now: Date; prev?: string }) {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="mb-1 text-[32px] leading-tight md:text-[34px]">Figures</h1>
        <p className="text-muted">Read-only numbers and lists. Each block shows only if your roles may read it.</p>
      </header>
      {b.targets && <TargetsBlock d={b.targets} />}
      {b.signup && <SignupBlock d={b.signup} />}
      {b.rises && <RisesBlock d={b.rises} />}
      {b.overdue && <OverdueBlock d={b.overdue} now={now} />}
      {b.checks && <ChecksBlock d={b.checks} />}
      {b.sample && <SampleBlock d={b.sample} />}
      {b.decisions && <DecisionsBlock d={b.decisions} prev={prev} />}
    </div>
  );
}
