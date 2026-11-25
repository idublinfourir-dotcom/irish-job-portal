// Company name merges (frame D07) as parts that take their data as props, so a test renders every state. Two jobs, both done by staff and never automatically (#234 D1, CF76):
// the DETE names that look like one of our companies (confirm the link, or say they are not the same), and the merge of two company pages the staff member picks.
import type { CompanyPreview } from "@portal/db";
import { A, Button, EmptyState, Input, Notice, Pager, Pill } from "@portal/ui";
import { PostButton } from "../_queue/post-button";

export type Suggestion = { deteName: string; permits: number; organisationId: string; organisation: string; matchedName: string; kind: string };
export const LINK_VIEWERS = ["account_reviewer", "trust_and_safety", "administrator"];
export const LINK_ACTORS = ["account_reviewer"];
export const MERGE_ROLES = ["account_reviewer", "fetched_job_reviewer", "rules_data_editor", "trust_and_safety", "administrator"];
export const MERGE_ACTORS = ["account_reviewer", "fetched_job_reviewer"];
export const PAGE = 50;
export const href = (page: number, a?: string, b?: string) => `/name-merges?${new URLSearchParams({ ...(page > 1 ? { page: String(page) } : {}), ...(a ? { a } : {}), ...(b ? { b } : {}) })}`.replace(/\?$/, "");
const permitsText = (n: number) => (n === 1 ? "1 permit" : `${n} permits`);
const may = (roles: string[], want: string[]) => roles.some((r) => want.includes(r));

export function Suggestions({ items, total, page, roles }: { items: Suggestion[]; total: number; page: number; roles: string[] }) {
  const canAct = may(roles, LINK_ACTORS);
  if (items.length === 0)
    return <EmptyState icon="copy" title={page > 1 ? "No names on this page" : "No DETE names to link"}>{page > 1 ? <A href={href(1)} className="font-semibold underline">Back to the first page</A> : "Every DETE name that looks like one of our companies is already linked or turned down."}</EmptyState>;
  return (
    <div className="flex flex-col gap-3">
      {!canAct && <Notice kind="info">Only an account reviewer confirms a link. You can read the list.</Notice>}
      <ul className="flex flex-col gap-3">
        {items.map((s) => (
          <li key={`${s.deteName}\t${s.organisationId}`} className="grid items-center gap-x-6 gap-y-3 rounded-card bg-sand p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <div className="min-w-0">
              <p className="font-semibold [overflow-wrap:anywhere]">{s.deteName}</p>
              <p className="text-small text-muted">DETE legal name · {permitsText(s.permits)}</p>
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-deep-green [overflow-wrap:anywhere]">{s.organisation}</p>
              <p className="text-small text-muted [overflow-wrap:anywhere]">{s.kind === "exact" ? "Same name as" : "Similar to"} {s.matchedName}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={s.kind === "exact" ? "green" : "peach"} className="min-h-[30px]">{s.kind === "exact" ? "Same name" : "Similar name"}</Pill>
              {canAct && (
                <>
                  <PostButton url="/api/companies/dete-links" body={{ action: "link", deteName: s.deteName, organisationId: s.organisationId }} label="Confirm link" back={href(page)}
                    confirm={{ title: "Link this DETE name to the company?", text: `"${s.deteName}" becomes a legal name of ${s.organisation}. Its permit history and sponsor sort change at once.`, button: "Confirm link" }} />
                  <PostButton url="/api/companies/dete-links" body={{ action: "reject", deteName: s.deteName, organisationId: s.organisationId }} label="Not the same" variant="chip" back={href(page)} />
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      {(page > 1 || page * PAGE < total) && <Pager prevHref={page > 1 ? href(page - 1) : undefined} nextHref={page * PAGE < total ? href(page + 1) : undefined} />}
    </div>
  );
}

function CompanyCard({ c }: { c: CompanyPreview }) {
  return (
    <section aria-label={c.display_name} className="min-w-0 rounded-card bg-sand p-4">
      <h3 className="text-[18px] [overflow-wrap:anywhere]">{c.display_name}</h3>
      <p className="mb-3 text-small text-muted">{c.kind} · {c.status.replaceAll("_", " ")}{c.cro_number ? ` · CRO ${c.cro_number}` : ""}</p>
      <dl className="grid grid-cols-3 gap-2 text-small">
        <div><dt className="text-muted">Names</dt><dd className="font-semibold">{c.names}</dd></div>
        <div><dt className="text-muted">Jobs</dt><dd className="font-semibold">{c.jobs}</dd></div>
        <div><dt className="text-muted">Active members</dt><dd className="font-semibold">{c.active_members}</dd></div>
      </dl>
      {c.merged_into_id && <p className="mt-2 text-small text-muted">Already merged into another company.</p>}
    </section>
  );
}

export function MergeTwo({ a, b, found, roles, page }: { a?: string; b?: string; found: CompanyPreview[] | null; roles: string[]; page: number }) {
  const [x, y] = [a, b].map((id) => found?.find((c) => c.id === id));
  const canMerge = may(roles, MERGE_ACTORS);
  const back = href(page, a, b);
  const merge = (keep: CompanyPreview, drop: CompanyPreview) => (
    <PostButton key={keep.id} url="/api/companies/merge" body={{ absorbedId: drop.id, survivorId: keep.id }} label={`Keep ${keep.display_name}`} variant="outline" back={back}
      confirm={{ title: "Merge these two companies?", text: `${drop.display_name} is merged into ${keep.display_name}: its names (with their DETE links) and jobs move over and it is marked merged. There is no undo button; the audit log lists everything that moved.`, button: "Merge" }} />
  );
  return (
    <section aria-label="Merge two companies" className="flex flex-col gap-4 rounded-bento bg-lilac-soft p-5">
      <header>
        <h2 className="text-[22px]">Merge two companies</h2>
        <p className="text-small text-muted">Pick the two company numbers, check what would move, then say which one stays.</p>
      </header>
      <form method="get" action="/name-merges" className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Input label="Company number" name="a" defaultValue={a ?? ""} inputMode="numeric" pattern="[1-9][0-9]{0,17}" maxLength={18} required />
        <Input label="Other company number" name="b" defaultValue={b ?? ""} inputMode="numeric" pattern="[1-9][0-9]{0,17}" maxLength={18} required />
        <Button type="submit" variant="dark" size="md">Compare</Button>
      </form>
      {a && b && a === b && <Notice kind="warning">Pick two different companies.</Notice>}
      {found && a !== b && (
        <>
          {(!x || !y) && <Notice kind="warning">{!x && !y ? "Neither company number was found." : `Company number ${x ? b : a} was not found.`}</Notice>}
          <div className="grid gap-3 sm:grid-cols-2">{x && <CompanyCard c={x} />}{y && <CompanyCard c={y} />}</div>
          {x && y && (canMerge ? <div className="flex flex-wrap gap-2">{merge(x, y)}{merge(y, x)}</div> : <Notice kind="info">Only an account reviewer or a fetched-job reviewer merges companies. You can look.</Notice>)}
        </>
      )}
    </section>
  );
}

/** The whole page body. `links` is null when the member's roles do not read the name links (the merge part still shows). */
export function NameMerges({ links, roles, page, a, b, found }: { links: { suggestions: Suggestion[]; total: number } | null; roles: string[]; page: number; a?: string; b?: string; found: CompanyPreview[] | null }) {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="mb-1 text-[32px] leading-tight md:text-[34px]">Company name merges</h1>
        <p className="text-muted">Nothing is linked or merged automatically: a person confirms each one, and every confirmation is written to the audit log.</p>
      </header>
      {links ? (
        <section aria-label="DETE names to link" className="flex flex-col gap-3">
          <h2 className="flex items-center gap-2 text-[22px]">DETE names to link <span className="rounded-pill bg-lilac px-2.5 text-small font-semibold leading-7">{links.total}</span></h2>
          <Suggestions items={links.suggestions} total={links.total} page={page} roles={roles} />
        </section>
      ) : (
        <Notice kind="info" title="The DETE name links are not for your roles">Account reviewers, trust and safety and administrators read them.</Notice>
      )}
      <MergeTwo a={a} b={b} found={found} roles={roles} page={page} />
    </div>
  );
}
