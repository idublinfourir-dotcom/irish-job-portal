// A company's staff page: its email domains, member limit and owner reassignment. Account reviewers and administrators (an administrator reads the owner requests
// only through an account reviewer: the route is theirs). Domains are typed by staff; names come from the company: text only.
import type { CompanyPreview, DomainRow, OpenRequest } from "@portal/db";
import { EmptyState, Notice } from "@portal/ui";
import { Act } from "../../_queue/act";
import { ageText, when } from "../../_queue/age";
import { Head } from "../../_queue/page-head";

export const COMPANY_REASONS: readonly (readonly [string, string])[] = [["checked_by_staff", "Checked by staff"], ["company_request", "The company asked"], ["staff_correction", "Correcting a mistake"], ["other", "Another reason"]];
export const isCompanyId = (v: string) => /^[1-9]\d{0,18}$/.test(v);

export function Domains({ id, domains }: { id: string; domains: DomainRow[] }) {
  const here = `/companies/${id}`;
  return (
    <section aria-label="Email domains" className="flex flex-col gap-4 rounded-card bg-sand p-5 sm:p-6">
      <h2 className="text-[22px]">Email domains</h2>
      <p className="text-small text-muted">A person whose work email is on one of these domains joins the company without a review. A free email provider cannot be added, and neither can a domain another company holds.</p>
      {domains.length === 0 ? <p className="text-small">The company has no domain saved.</p> : (
        <ul className="divide-y divide-line rounded-card bg-white">
          {domains.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <span className="text-small [overflow-wrap:anywhere]"><b>{d.domain}</b> · {d.source.replaceAll("_", " ")} · added {when(d.createdAt)}</span>
              <Act url="/api/companies/domains" fixed={{ action: "remove", organisationId: id, domain: d.domain }} fields={[{ name: "reason", label: "Reason", kind: "select", options: COMPANY_REASONS }]} label="Remove" variant="outline" here={here} confirm={`Remove ${d.domain}? Colleagues on it then need a review to join.`} />
            </li>
          ))}
        </ul>
      )}
      <Act url="/api/companies/domains" fixed={{ action: "add", organisationId: id }} label="Add the domain" here={here}
        fields={[{ name: "domain", label: "Domain", kind: "text", maxLength: 253, required: true, help: "For example company.example" }, { name: "reason", label: "Reason", kind: "select", options: COMPANY_REASONS }]} />
    </section>
  );
}

export function MemberLimit({ id, active }: { id: string; active: number }) {
  return (
    <section aria-label="Member limit" className="flex flex-col gap-3 rounded-card bg-sand p-5 sm:p-6">
      <h2 className="text-[22px]">Member limit</h2>
      <p className="text-small text-muted">The most active members the company can have, from 1 to 50. It has {active} active {active === 1 ? "member" : "members"} now, and the limit cannot go below that.</p>
      <Act url="/api/companies/member-limit" fixed={{ organisationId: id }} label="Set the limit" here={`/companies/${id}`}
        fields={[{ name: "memberLimit", label: "Member limit", kind: "number", min: 1, max: 50 }, { name: "reason", label: "Reason", kind: "select", options: COMPANY_REASONS }]} />
    </section>
  );
}

export function Owner({ id, open, canUse, now }: { id: string; open: OpenRequest[]; canUse: boolean; now: Date }) {
  const here = `/companies/${id}`;
  if (!canUse) return (
    <section aria-label="Owner" className="flex flex-col gap-3 rounded-card bg-sand p-5 sm:p-6">
      <h2 className="text-[22px]">Owner</h2>
      <Notice kind="info">Only an account reviewer can change a company&apos;s owner.</Notice>
    </section>
  );
  return (
    <section aria-label="Owner" className="flex flex-col gap-4 rounded-card bg-sand p-5 sm:p-6">
      <h2 className="text-[22px]">Owner who cannot be reached</h2>
      <p className="text-small text-muted">Record a member&apos;s request to become the owner after you checked the company domain and the CRO number. The old owner is told, and after 7 days you complete the change. The old owner then becomes a recruiter.</p>
      {open.length === 0 ? <EmptyState icon="users" title="No request is open">A request you record waits here for its 7 days.</EmptyState> : (
        <ul className="flex flex-col gap-3">
          {open.map((r) => (
            <li key={r.id} className="flex flex-col gap-3 rounded-card bg-white p-4">
              <p className="text-small [overflow-wrap:anywhere]">New owner <b>{r.new_owner_email}</b> (member {r.new_owner_membership_id}), replacing {r.old_owner_email ?? "an owner with no email"}. Recorded {when(r.requested_at)} ({ageText(r.requested_at, now)} ago). {r.can_complete ? "The 7 days have passed." : `Can be completed from ${when(r.completes_after)}.`}</p>
              <div className="flex flex-wrap gap-4">
                <Act url="/api/companies/owner-reassign" fixed={{ action: "complete", requestId: r.id }} label="Complete the change" here={here} confirm="Make this member the owner now? The old owner becomes a recruiter." />
                <Act url="/api/companies/owner-reassign" fixed={{ action: "cancel", requestId: r.id }} label="Cancel the request" variant="outline" here={here} confirm="Cancel this request? Nothing changes." />
              </div>
            </li>
          ))}
        </ul>
      )}
      {open.length === 0 && (
        <Act url="/api/companies/owner-reassign" fixed={{ action: "request" }} label="Record the request" here={here}
          fields={[{ name: "membershipId", label: "Member id of the new owner", kind: "text", maxLength: 19, required: true, help: "The member number from the company's team." }, { name: "domainChecked", label: "I checked the company's email domain", kind: "check" }, { name: "croChecked", label: "I checked the CRO number", kind: "check" }]} />
      )}
    </section>
  );
}

export function Company({ c, domains, open, canOwner, now }: { c: CompanyPreview; domains: DomainRow[]; open: OpenRequest[]; canOwner: boolean; now: Date }) {
  return (
    <div className="flex flex-col gap-6">
      <Head title={c.display_name}>{c.kind.replaceAll("_", " ")} · {c.status.replaceAll("_", " ")} · {c.jobs} {c.jobs === 1 ? "job" : "jobs"}{c.cro_number ? ` · CRO ${c.cro_number}` : ""}</Head>
      {c.merged_into_id !== null && <Notice kind="warning">This company was merged into <a className="font-semibold underline" href={`/companies/${c.merged_into_id}`}>company {c.merged_into_id}</a>. Domains cannot be added to it.</Notice>}
      <Domains id={c.id} domains={domains} />
      <MemberLimit id={c.id} active={c.active_members} />
      <Owner id={c.id} open={open} canUse={canOwner} now={now} />
      <p className="text-small text-muted">Every action is written to the audit log.</p>
    </div>
  );
}
