// DETE name links (Q5): DETE employer names that no row links to a company yet, each with the company the name matcher suggests. An account reviewer links a name or turns
// the suggestion down; trust and safety and administrators read. DETE names and company names are text from outside: shown as text only.
import type { DeteSuggestion } from "@portal/db";
import { A, EmptyState, Notice, Pager, Pill } from "@portal/ui";
import { Act } from "../../_queue/act";
import { Head } from "../../_queue/page-head";

export const href = (page = 1) => `/companies/dete-links${page > 1 ? `?page=${page}` : ""}`;

export function DeteLinks({ items, total, page, canAct, next, prev }: { items: DeteSuggestion[]; total: number; page: number; canAct: boolean; next?: string; prev?: string }) {
  const here = href(page);
  return (
    <div className="flex flex-col gap-6">
      <Head title="DETE name links">DETE employer names that are not linked to a company yet, with the company the name matcher suggests. {total} {total === 1 ? "suggestion" : "suggestions"}.</Head>
      {!canAct && <Notice kind="info">You can read the suggestions. Only an account reviewer can link a name or turn a suggestion down.</Notice>}
      {items.length === 0 ? <EmptyState icon="building" title="No suggestion is waiting">Every DETE name is linked, or no company matches one.</EmptyState> : (
        <ul className="overflow-hidden rounded-card border border-line bg-white">
          {items.map((s) => (
            <li key={`${s.organisationId}:${s.deteName}`} className="flex flex-col gap-3 border-b border-line px-4 py-4 last:border-b-0 odd:bg-sand/60">
              <p className="[overflow-wrap:anywhere]">
                <b>{s.deteName}</b> ({s.permits} {s.permits === 1 ? "permit" : "permits"}) may be{" "}
                <A href={`/companies/${s.organisationId}`} className="font-semibold text-deep-green underline">{s.organisation}</A>
                {" "}<Pill tone="lilac" className="min-h-[26px] px-3 text-small">{s.kind === "exact" ? "Same name" : "Close name"}</Pill>
              </p>
              <p className="text-small text-muted [overflow-wrap:anywhere]">Matched on the company name &quot;{s.matchedName}&quot;.</p>
              {canAct && (
                <div className="flex flex-wrap gap-4">
                  <Act url="/api/companies/dete-links" fixed={{ action: "link", deteName: s.deteName, organisationId: s.organisationId }} label="Link this name" here={here} confirm={`Link the DETE name to ${s.organisation}? Its permit history then counts for this company.`} />
                  <Act url="/api/companies/dete-links" fixed={{ action: "reject", deteName: s.deteName, organisationId: s.organisationId }} label="Not this company" variant="outline" here={here} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {(next || prev) && <Pager prevHref={prev} nextHref={next} />}
      <p className="text-small text-muted">Every action is written to the audit log.</p>
    </div>
  );
}
