// The ban list (frame D09) as parts that take their data as props. A ban is added by a decided case and lifted by two officers from that case (#44, #104), so there is no Add and no Remove
// here: each row opens its case. The scam wording is read-only: it is code, not a list staff edit (L9).
import { A, EmptyState, Notice, Pager, Pill, cx } from "@portal/ui";
import { when } from "../_queue/age";
import { iso, reasonText } from "../reports/text";

export type Ban = { banId: string; type: string; value: string; reasonCode: string; caseId: string; caseLabel: string; displayName: string; addedAt: string | Date | null; proposedBy: string | null; confirmedBy: string | null; liftPending: boolean };
export type Wrc = { caseId: string; caseLabel: string; displayName: string; reasonCode: string; reportedAt: string | Date; reportedBy: string | null };

const TYPE: Record<string, string> = { cro_number: "CRO number", email_domain: "Email domain", email_address: "Email address" };
export const typeText = (t: string) => TYPE[t] ?? "Value";
export const caseHref = (label: string) => `/reports?id=${label}`;

/** What the advert check looks for, in words. It is the rule's own code, shown so staff know what raises a flag; changing it is a code change, not a form. */
export const SCAM_WORDING = [
  "asks the candidate to pay or send a fee, a deposit or a processing charge",
  "a registration fee",
  "a visa fee payable by the candidate",
] as const;

export function Bans({ items, next, prev }: { items: Ban[]; next?: string; prev?: string }) {
  if (items.length === 0) return <EmptyState icon="close" title="No bans yet">A ban appears here when a case is decided with a ban or a third strike.</EmptyState>;
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-card border border-line bg-white">
        <div aria-hidden="true" className="hidden grid-cols-[8rem_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1fr)_5rem_minmax(0,1.2fr)] gap-3 border-b border-line px-4 py-3 text-small font-semibold md:grid">
          <span>Type</span><span>Value</span><span>Organisation</span><span>Reason</span><span>Case</span><span>Added</span>
        </div>
        <ul>
          {items.map((b) => (
            <li key={`${b.banId}-${b.type}`} className="grid gap-x-3 gap-y-1 border-b border-line px-4 py-3 text-small last:border-b-0 odd:bg-sand/60 md:grid-cols-[8rem_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1fr)_5rem_minmax(0,1.2fr)] md:items-center">
              <span><Pill tone="lilac" className="min-h-[30px]">{typeText(b.type)}</Pill></span>
              <span className="font-semibold [overflow-wrap:anywhere]">{b.value}</span>
              <span className="[overflow-wrap:anywhere]">{b.displayName}</span>
              <span>{reasonText(b.reasonCode)}{b.liftPending && <> <Pill tone="peach" className="min-h-[26px]">Lift waiting</Pill></>}</span>
              <A href={caseHref(b.caseLabel)} className="font-semibold text-deep-green underline">{b.caseLabel}</A>
              <span className="text-muted">{[b.proposedBy, b.confirmedBy].filter(Boolean).join(" and ") || "Staff"} &middot; {b.addedAt ? when(iso(b.addedAt)) : ""}</span>
            </li>
          ))}
        </ul>
      </div>
      {(next || prev) && <Pager prevHref={prev} nextHref={next} />}
    </div>
  );
}

export function WrcList({ items, next, prev }: { items: Wrc[]; next?: string; prev?: string }) {
  if (items.length === 0) return <p className="text-small text-muted">No case has been reported to the WRC yet.</p>;
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-card border border-line bg-white">
        <ul>
          {items.map((w) => (
            <li key={w.caseId} className={cx("grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-b border-line px-4 py-3 text-small last:border-b-0 odd:bg-sand/60")}>
              <span className="font-semibold [overflow-wrap:anywhere]">{w.displayName}</span>
              <span className="text-right text-muted">{when(iso(w.reportedAt))}</span>
              <span className="text-muted">{reasonText(w.reasonCode)}{w.reportedBy ? ` · ticked by ${w.reportedBy}` : ""}</span>
              <A href={caseHref(w.caseLabel)} className="text-right font-semibold text-deep-green underline">{w.caseLabel}</A>
            </li>
          ))}
        </ul>
      </div>
      {(next || prev) && <Pager prevHref={prev} nextHref={next} />}
    </div>
  );
}

export function BanList({ bans, wrc, missing }: { bans: { items: Ban[]; next?: string; prev?: string }; wrc: { items: Wrc[]; next?: string; prev?: string }; missing?: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="mb-1 text-[32px] leading-tight md:text-[34px]">Ban list</h1>
        <p className="text-muted">Blocked company registration numbers and email addresses cannot sign up again. A ban comes from a decided case, and a lift is proposed on the case and confirmed by a second officer.</p>
      </header>
      {missing && <Notice kind="warning">That page link is not valid, so the first page shows.</Notice>}
      <Bans {...bans} />
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-2">
        <section className="flex flex-col gap-3 rounded-card bg-sand p-5 sm:p-6 lg:rounded-bento" aria-label="Scam wording">
          <h2 className="text-[22px]">Scam wording flags</h2>
          <p className="text-small text-muted">Run on posted and fetched jobs. A flag sends the job to a person. It is part of the rules code, so it is read here and not edited. An employer&apos;s own warning against scams does not count.</p>
          <ul className="flex flex-wrap gap-2">{SCAM_WORDING.map((w) => <li key={w}><Pill tone="peach" className="bg-error-tint text-error">{w}</Pill></li>)}</ul>
        </section>
        <section className="flex flex-col gap-3 rounded-card bg-sand p-5 sm:p-6 lg:rounded-bento" aria-label="Reported to the WRC">
          <h2 className="text-[22px]">Reported to the WRC</h2>
          <p className="text-small text-muted">Agencies banned for asking candidates for money are reported. Staff tick it off on the case.</p>
          <WrcList {...wrc} />
        </section>
      </div>
    </div>
  );
}
