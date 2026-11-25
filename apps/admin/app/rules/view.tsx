// The rules data pages (frames ND3, D05, D06) as parts that take their data as props, so a test renders every state. Every figure is read; a value that is not in force yet is labelled as a
// next value or a proposal and never sits in the "current" column. A change is two people: a rules data editor proposes, a different administrator confirms (the proposer sees Withdraw only).
import type { BigName, Occupation, PastVersion, Pending, PayDealList, PayDealRow, PayScale, Version, Minimums } from "@portal/db";
import { A, Notice, Pill, cx } from "@portal/ui";
import { ageText } from "../_queue/age";
import { PostButton } from "../_queue/post-button";
import { Head } from "../_queue/page-head";
import { FlagForm, ListEditor, MinimumsEditor, PayDealForm } from "./actions";
import { BODY_LABEL, changeLines, dayText, eur, EVIDENCE_LABEL, HISTORY_KINDS, KIND_LABEL, KIND_OF_TAB, minimumRows, pendingFor, TABS, type Tab } from "./text";

export type Who = { id: string; roles: string[] };
const canPropose = (w: Who) => w.roles.includes("rules_data_editor");

export type NavKey = Tab | "pay_deal" | "big";
/** The tabs of every rules page: the five lists on /rules, then the two pages of their own (frames ND3, D05). */
export function RulesNav({ active }: { active: NavKey }) {
  const items: [NavKey, string, string][] = [...TABS.map(([t, l]) => [t, l, `/rules?tab=${t}`] as [NavKey, string, string]), ["pay_deal", "Pay-deal employers", "/rules/pay-deal-employers"], ["big", "Big-company list", "/rules/big-companies"]];
  return (
    <nav aria-label="Rules data" className="flex gap-1 overflow-x-auto border-b border-line">
      {items.map(([k, label, href]) => (
        <A key={k} href={href} aria-current={k === active ? "page" : undefined} className={cx("flex min-h-11 shrink-0 items-center border-b-4 px-3 text-small font-semibold no-underline", k === active ? "border-deep-green text-deep-green" : "border-transparent text-ink hover:bg-hover-light")}>{label}</A>
      ))}
    </nav>
  );
}

/** The proposals waiting, each with its change and who proposed it. The proposer can withdraw and never confirm; an administrator who did not propose confirms or refuses. */
export function PendingList({ items, who, back, now }: { items: Pending[]; who: Who; back: string; now: Date }) {
  if (items.length === 0) return null;
  const admin = who.roles.includes("administrator");
  return (
    <section aria-label="Waiting for a second person" className="flex flex-col gap-3 rounded-bento bg-lilac-soft p-5">
      <h2 className="text-[22px]">Waiting for a different administrator</h2>
      <ul className="flex flex-col gap-3">
        {items.map((p) => {
          const mine = p.proposedBy === who.id;
          const lines = "change" in p ? changeLines(p.change) : [`Flag ${p.displayName ?? `company ${p.organisationId}`} as a big company`];
          return (
            <li key={p.requestId} className="flex flex-col gap-2 rounded-card bg-white p-4">
              <p className="font-semibold">{KIND_LABEL[p.kind] ?? p.kind}{"effectiveFrom" in p ? <span className="font-normal text-muted"> · starts {dayText(p.effectiveFrom)}</span> : null}</p>
              <p className="text-small text-muted">Proposed by {mine ? "you" : p.proposedByName} · {ageText(p.createdAt, now)} ago</p>
              {lines.length === 0 ? <p className="text-small">No entry differs from the version in force.</p> : <ul className="list-disc pl-5 text-small [overflow-wrap:anywhere]">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
              {mine && <p className="text-small">A different administrator confirms it. You can withdraw it.</p>}
              {!mine && !admin && <p className="text-small text-muted">An administrator decides this.</p>}
              <div className="flex flex-wrap gap-2">
                {admin && !mine && <PostButton url="/api/rules" body={{ action: "confirm", requestId: p.requestId }} label="Confirm" back={back} confirm={{ title: "Confirm this change?", text: "It takes effect on its start day. New minimums email every company with a live or draft job.", button: "Confirm" }} />}
                {admin && !mine && <PostButton url="/api/rules" body={{ action: "refuse", requestId: p.requestId }} label="Refuse" variant="chip" back={back} confirm={{ title: "Refuse this change?", text: "The proposal is closed and nothing changes.", button: "Refuse" }} />}
                {mine && <PostButton url="/api/rules" body={{ action: "withdraw", requestId: p.requestId }} label="Withdraw" variant="chip" back={back} confirm={{ title: "Withdraw your proposal?", text: "The proposal is closed and nothing changes.", button: "Withdraw" }} />}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Upcoming({ kind, upcoming }: { kind: string; upcoming: Version[] }) {
  const u = upcoming.filter((v) => v.kind === kind);
  if (u.length === 0) return null;
  return <Notice kind="info" title="A confirmed version has not started yet">{u.map((v) => `It starts on ${dayText(v.effectiveFrom)}.`).join(" ")} The figures below are the ones in force today.</Notice>;
}

export function MinimumsTable({ inForce, upcoming }: { inForce: Version | undefined; upcoming: Version[] }) {
  const rows = minimumRows(inForce, upcoming);
  if (rows.length === 0) return <p className="text-small text-muted">No salary minimums are in force.</p>;
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-white">
      <table className="w-full min-w-[46rem] text-left text-small">
        <caption className="sr-only">Salary minimums in force today</caption>
        <thead><tr className="border-b border-line bg-lilac-soft">{["Permit", "Case", "In force now", "Since", "Source checked", "Next value", "Starts"].map((h) => <th key={h} scope="col" className="px-3 py-3 font-semibold">{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.text} className="border-b border-line align-top last:border-b-0 odd:bg-sand/60">
              <td className="px-3 py-2.5"><Pill tone={r.permit === "General" ? "lilac" : "outline"}>{r.permit}</Pill></td>
              <td className="px-3 py-2.5">{r.text}</td>
              <td className="whitespace-nowrap px-3 py-2.5 font-semibold">{eur(r.now)}{r.hourly !== null && <span className="font-normal text-muted"> · {`€${r.hourly.toFixed(2)}`}/h</span>}</td>
              <td className="px-3 py-2.5">{dayText(r.from)}</td>
              <td className="px-3 py-2.5">{dayText(r.checked)}</td>
              <td className="px-3 py-2.5">{r.next === null ? <span className="text-muted">Not entered</span> : eur(r.next)}</td>
              <td className="px-3 py-2.5">{r.nextFrom ? dayText(r.nextFrom) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Codes({ title, codes, none }: { title: string; codes: string[] | undefined; none: string }) {
  return (
    <section className="flex flex-col gap-2 rounded-bento bg-lilac-soft p-5"><h2 className="text-[22px]">{title}</h2>
      {codes && codes.length > 0 ? <ul className="flex flex-wrap gap-2">{codes.map((c) => <li key={c}><Pill tone="white">{c}</Pill></li>)}</ul> : <p className="text-small text-muted">{none}</p>}</section>
  );
}

/** Quotas: the codes the General minimums version holds. A code with a full quota takes no new General job. Changed with the minimums form. */
export function Quotas({ m }: { m: Minimums | undefined }) {
  const full = m?.generalQuotaFullCodes, lower = m?.generalLowerCodes;
  if (!m || (!full && !lower)) return <p className="text-small text-muted">The version in force holds no General permit figures, so it has no quota codes.</p>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Codes title="Quota full" codes={full} none="No code has a full quota." />
      <Codes title="Lower rate" codes={lower} none="No code is at the lower rate." />
    </div>
  );
}

export function HistoryView({ kind, items, prev, next }: { kind: string; items: PastVersion[]; prev?: string; next?: string }) {
  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Kind" className="flex flex-wrap gap-2">
        {HISTORY_KINDS.map((k) => <A key={k} href={`/rules?tab=history&kind=${k}`} aria-current={k === kind ? "page" : undefined} className={cx("inline-flex min-h-9 items-center rounded-pill px-3.5 text-small font-semibold no-underline", k === kind ? "bg-ink text-white" : "bg-lilac text-ink")}>{KIND_LABEL[k]}</A>)}
      </nav>
      {items.length === 0 && <p className="text-small text-muted">No version of this kind has started yet.</p>}
      <ol className="flex flex-col gap-3">
        {items.map((v) => {
          const lines = changeLines(v.change);
          return (
            <li key={v.versionId} className="flex flex-col gap-2 rounded-card border border-line bg-white p-4">
              <p className="font-semibold">{dayText(v.effectiveFrom)} to {v.until ? dayText(v.until) : "now"}{v.inForce && <Pill tone="green" className="ml-2 min-h-[26px]">In force</Pill>}</p>
              <p className="text-small text-muted">{v.seeded ? "The first version." : `Proposed by ${v.proposedByName ?? "a person"}, confirmed by ${v.confirmedByName ?? "an administrator"}${v.confirmedAt ? ` on ${dayText(v.confirmedAt)}` : ""}.`}</p>
              {lines.length > 0 && <ul className="list-disc pl-5 text-small [overflow-wrap:anywhere]">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
            </li>
          );
        })}
      </ol>
      <div className="flex gap-3 text-small font-semibold">{prev && <A href={prev}>Previous</A>}{next && <A href={next}>Next</A>}</div>
    </div>
  );
}

const at = (inForce: Version[], kind: string) => inForce.find((v) => v.kind === kind);

export type RulesProps = {
  tab: Tab; inForce: Version[]; upcoming: Version[]; pending: Pending[]; who: Who; today: string; now: Date;
  history?: { kind: string; items: PastVersion[]; prev?: string; next?: string };
};
export function Rules(p: RulesProps) {
  const mins = at(p.inForce, "minimums"), edit = canPropose(p.who);
  const kind = p.tab === "history" ? (p.history?.kind ?? "minimums") : p.tab === "quotas" ? "minimums" : KIND_OF_TAB[p.tab];
  const here = p.tab === "history" ? `/rules?tab=history&kind=${kind}` : `/rules?tab=${p.tab}`;
  const rows = (k: string) => ((at(p.inForce, k)?.data ?? []) as unknown as (Occupation | PayScale)[]);
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <Head title="Rules data">Every figure here is read from the database, none is written into the code. A change is proposed by a rules data editor and confirmed by a different administrator.</Head>
        <div className="flex flex-wrap gap-2">
          {edit && mins && (p.tab === "minimums" || p.tab === "quotas") && <MinimumsEditor m={mins.data as Minimums} today={p.today} />}
          {p.tab !== "history" && <A href={`/rules?tab=history&kind=${kind}`} className="inline-flex min-h-11 items-center rounded-pill border border-ink px-5 font-semibold no-underline">History</A>}
        </div>
      </header>
      <RulesNav active={p.tab === "history" ? "minimums" : p.tab} />
      <PendingList items={pendingFor(p.pending, [kind])} who={p.who} back={here} now={p.now} />
      {p.tab !== "history" && <Upcoming kind={kind} upcoming={p.upcoming} />}
      {p.tab === "minimums" && <MinimumsTable inForce={mins} upcoming={p.upcoming} />}
      {p.tab === "quotas" && <Quotas m={mins?.data as Minimums | undefined} />}
      {(p.tab === "critical" || p.tab === "ineligible" || p.tab === "scales") && <ListEditor kind={kind as "critical_skills_list"} rows={rows(kind)} today={p.today} canEdit={edit} back={here} />}
      {p.tab === "history" && p.history && <HistoryView {...p.history} />}
    </div>
  );
}

// ===== frame D05: pay-deal employers =====
const evidenceCell = (r: PayDealRow) =>
  !r.evidence ? <Pill tone="peach" className="min-h-[28px]">Evidence missing</Pill> : (
    <span className="flex flex-col gap-0.5">
      <span>{EVIDENCE_LABEL[r.evidence.kind] ?? r.evidence.kind}</span>
      {r.evidence.link && <A href={r.evidence.link} rel="noopener noreferrer" className="underline">Link</A>}
      {r.evidence.file && <A href={`/api/rules/evidence?file=${encodeURIComponent(r.evidence.file.id)}`} className="underline [overflow-wrap:anywhere]">{r.evidence.file.name}</A>}
    </span>
  );

export type PayDealProps = { items: PayDealRow[]; versionId: string | null; data: PayDealList; selected: string | null; pending: Pending[]; who: Who; today: string; now: Date };
export function PayDeal(p: PayDealProps) {
  const sel = p.items.find((r) => r.name === p.selected) ?? null, edit = canPropose(p.who), back = sel ? `/rules/pay-deal-employers?employer=${encodeURIComponent(sel.name)}` : "/rules/pay-deal-employers";
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <Head title="Rules data: pay-deal employers">A job at one of these employers passes the salary check and shows &quot;Public sector pay scale applies&quot;. Each entry needs evidence.</Head>
        {edit && p.versionId !== null && <PayDealForm data={p.data} selected={null} today={p.today} back={back} />}
      </header>
      <RulesNav active="pay_deal" />
      <PendingList items={pendingFor(p.pending, ["public_pay_employers"])} who={p.who} back={back} now={p.now} />
      {p.versionId === null && <Notice kind="info">No pay-deal list is in force yet.</Notice>}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="overflow-x-auto rounded-card border border-line bg-white">
          <table className="w-full min-w-[40rem] text-left text-small">
            <caption className="sr-only">Pay-deal employers in force today</caption>
            <thead><tr className="border-b border-line bg-lilac-soft">{["Employer", "Type", "Evidence", "Added", "Added by", "On"].map((h) => <th key={h} scope="col" className="px-3 py-3 font-semibold">{h}</th>)}</tr></thead>
            <tbody>
              {p.items.map((r) => (
                <tr key={r.name} className={cx("border-b border-line align-top last:border-b-0", r.name === sel?.name ? "bg-lilac-soft" : r.evidence ? "" : "bg-peach/40")}>
                  <th scope="row" className="px-3 py-2.5 font-semibold capitalize"><A href={`/rules/pay-deal-employers?employer=${encodeURIComponent(r.name)}`} aria-current={r.name === sel?.name ? "true" : undefined} className="no-underline">{r.name}</A></th>
                  <td className="px-3 py-2.5">{r.bodyType ? <Pill tone="lilac" className="min-h-[28px]">{BODY_LABEL[r.bodyType]}</Pill> : <span className="text-muted">Not recorded</span>}</td>
                  <td className="px-3 py-2.5">{evidenceCell(r)}</td>
                  <td className="px-3 py-2.5">{r.addedOn ? dayText(r.addedOn) : <span className="text-muted">First list</span>}</td>
                  <td className="px-3 py-2.5">{r.addedByName ?? <span className="text-muted">The owner</span>}</td>
                  <td className="px-3 py-2.5"><Pill tone={r.on ? "green" : "neutral"} className="min-h-[28px]">{r.on ? "On" : "Off"}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {sel && (
          <aside aria-label={sel.name} className="flex flex-col gap-4 rounded-bento bg-sand p-5">
            <h2 className="text-[22px] capitalize [overflow-wrap:anywhere]">{sel.name}</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-small">
              <dt className="text-muted">Added</dt><dd>{sel.addedOn ? dayText(sel.addedOn) : "First list"}{sel.addedByName ? ` · ${sel.addedByName}` : ""}</dd>
              <dt className="text-muted">Companies matched</dt><dd>{sel.companies}</dd>
              <dt className="text-muted">Linked entities</dt><dd>{sel.legalNames} legal {sel.legalNames === 1 ? "name" : "names"}</dd>
              <dt className="text-muted">Live jobs</dt><dd>{sel.liveJobs}</dd>
            </dl>
            {sel.bodyType === "section_39" && <Notice kind="warning" title="Open with DETE">Whether Section 39 and other voluntary bodies are covered is not confirmed. Add them only with recorded evidence of linked pay.</Notice>}
            {edit ? <PayDealForm key={sel.name} data={p.data} selected={sel.name} today={p.today} back={back} /> : <p className="text-small text-muted">Only a rules data editor proposes a change.</p>}
          </aside>
        )}
      </div>
    </div>
  );
}

// ===== frame D06: big companies =====
export type BigProps = { rows: BigName[]; pending: Pending[]; who: Who; today: string; now: Date; criticalSkills: number | null };
export function BigCompanies(p: BigProps) {
  const edit = canPropose(p.who);
  return (
    <div className="flex flex-col gap-5">
      <Head title="Big-company list">{`Brands whose pay for a role is known to clear the minimum. Jobs show "Salary not stated, expected above ${p.criticalSkills === null ? "the minimum" : eur(p.criticalSkills)}".`}</Head>
      <RulesNav active="big" />
      <Notice kind="info" title="Only when the brand's own legal entity is the employer">Never agency contractors, never SMEs, never General permit jobs.</Notice>
      <PendingList items={pendingFor(p.pending, ["big_company_names", "big_company_flag"])} who={p.who} back="/rules/big-companies" now={p.now} />
      <ListEditor kind="big_company_names" rows={p.rows} today={p.today} canEdit={edit} back="/rules/big-companies" />
      {edit && <FlagForm back="/rules/big-companies" />}
    </div>
  );
}
