// Frame E18: the company profile page. A presentational part: every value arrives as a prop from the page's reads (GET /api/portal/company, GET /api/portal/team), so a test renders every state.
// The frame's dummy data is never used (#287). Copy rows: CF20 county is editable, CF47 the 2000 limit, CF48 PNG, JPEG or WebP, CF100 the name is read-only with "ask us to fix it".
import type { ReactNode } from "react";
import { A, Button, Icon, Notice, Pill } from "@portal/ui";
import { initials } from "../_account/messages";
import { CloseCompany, ProfileForm } from "./forms";

export type Company = {
  name: string; slug: string; status: string; description: string | null; descriptionMax: number; website: string | null; county: string | null; claimed: boolean; labels: string[];
  croNumber: string | null; croStatus: string | null; legalNames: string[]; permitsSince: number; permitCount: number | null;
};
/** The companies a profile can be changed for (the route answers 409 for the others). */
export const EDITABLE = new Set(["pending_review", "needs_info", "verified", "verified_restricted"]);
const PUBLIC = new Set(["verified", "verified_restricted"]);

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid gap-1 py-1.5 sm:grid-cols-[11rem_1fr] sm:gap-4"><dt className="text-muted">{label}</dt><dd className="min-w-0 break-words font-medium">{children}</dd></div>;
}

export function CompanyView({ c, isOwner, logoSrc, publicHref, members, invites }: { c: Company; isOwner: boolean; logoSrc: string | null; publicHref: string | null; members: number | null; invites: number | null }) {
  const canEdit = isOwner && EDITABLE.has(c.status);
  const host = c.website ? c.website.replace(/^https?:\/\//, "").replace(/\/$/, "") : null;
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1>Company profile</h1>
          <p className="mt-1 text-muted">This is what candidates see on your company page.</p>
        </div>
        <div className="flex flex-wrap items-center gap-6">
          {publicHref && PUBLIC.has(c.status) && (
            <A href={publicHref} className="inline-flex min-h-11 items-center gap-2 font-semibold text-deep-green underline-offset-2 hover:underline"><Icon name="external" size={18} />View public page</A>
          )}
          {canEdit && <Button type="submit" form="profile-form" size="lg" className="hidden lg:inline-flex">Save</Button>}
        </div>
      </header>
      {isOwner && !canEdit && <Notice kind="warning" title="The profile cannot be changed now">This company is not open for changes. Open Account status to see where it stands.</Notice>}
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-6">
          <ProfileForm p={{ isOwner, name: c.name, description: c.description, website: c.website, county: c.county, descriptionMax: c.descriptionMax, logoSrc }} canEdit={canEdit} />
          <section aria-labelledby="records-h" className="rounded-bento bg-sand p-6 sm:p-8">
            <div className="flex flex-wrap items-baseline gap-x-3"><h2 id="records-h" className="text-[22px]">From the records</h2><p className="text-small text-muted">You cannot edit these</p></div>
            <dl className="mt-4">
              <Row label="Legal name">{c.legalNames.length ? c.legalNames.map((n) => <span key={n} className="block">{n}</span>) : "Not on record yet"}</Row>
              <Row label="CRO number">{c.croNumber ? `${c.croNumber}${c.croStatus ? ` · status ${c.croStatus}` : ""}` : "None given"}</Row>
              <Row label="DETE permit history">
                {c.permitCount === null ? "No permit record is linked to this company yet." : `${c.permitCount} ${c.permitCount === 1 ? "permit" : "permits"} since ${c.permitsSince}`}
                {c.labels.length > 0 && <span className="mt-1 flex flex-wrap gap-2">{c.labels.map((l) => <Pill key={l} tone="peach">{l}</Pill>)}</span>}
              </Row>
            </dl>
            <A href="/help?topic=account#contact" className="mt-3 inline-flex min-h-11 items-center font-semibold text-deep-green underline-offset-2 hover:underline">Something is wrong? Ask us to fix it</A>
          </section>
        </div>
        <aside aria-labelledby="preview-h" className="rounded-bento bg-sand p-6">
          <h2 id="preview-h" className="text-[22px]">Preview</h2>
          <div data-preview className="mt-4 flex flex-col gap-3 rounded-card border border-line bg-white p-5">
            <span aria-hidden="true" className="grid size-14 place-items-center overflow-hidden rounded-pill bg-white text-xl font-semibold text-sponsor-ink shadow-card">
              {logoSrc ? (
                // eslint-disable-next-line @next/next/no-img-element -- the company's own logo from the portal's public store
                <img src={logoSrc} alt="" className="size-full object-contain p-1" />
              ) : initials(c.name)}
            </span>
            <p className="font-heading text-xl font-semibold">{c.name}</p>
            {(c.county || host) && <p className="text-small text-muted">{[c.county, host].filter(Boolean).join(" · ")}</p>}
            {(c.claimed || c.labels.length > 0) && (
              <div className="flex flex-wrap gap-2">
                {c.claimed && <Pill tone="green"><Icon name="check" size={14} className="mr-1" />Claimed</Pill>}
                {c.labels.map((l) => <Pill key={l} tone="peach">{l}</Pill>)}
              </div>
            )}
            {c.description ? <p className="whitespace-pre-line text-small text-muted">{c.description}</p> : <p className="text-small text-muted">No description yet.</p>}
          </div>
          <p className="mt-3 text-small text-muted">Saved changes show here after you save.</p>
        </aside>
      </div>
      {canEdit && <CloseCompany name={c.name} members={members} invites={invites} />}
    </div>
  );
}
