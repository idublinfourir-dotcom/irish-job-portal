import type { ReactNode } from "react";
import { Button, Card, Input, Notice, Pill } from "@portal/ui";
import type { StaffSearch } from "@portal/db";

const MIN = 3, MAX = 100;

/** The page's parts, taking the result as props so a test renders every state. */
export function SearchView({ q, found, problem }: { q: string; found?: StaffSearch; problem?: string }) {
  const kinds = found ? Object.keys(found).length : 0;
  return (
    <div className="flex flex-col gap-6">
      <h1>Search</h1>
      <form action="/search" method="get" role="search" className="flex max-w-2xl flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Input label="Search organisations, jobs and cases" name="q" type="search" defaultValue={q} minLength={MIN} maxLength={MAX} required />
        </div>
        <Button type="submit" variant="dark" size="lg">Search</Button>
      </form>
      {problem && <Notice kind="warning">{problem}</Notice>}
      {found && kinds === 0 && <Notice kind="info">Your roles do not let you search organisations, jobs or cases.</Notice>}
      {found?.organisations && (
        <Section title="Organisations" more={found.organisations.more} empty={found.organisations.items.length === 0}>
          {found.organisations.items.map((o) => (
            <Row key={o.id} title={o.displayName} meta={[o.croNumber ? `CRO ${o.croNumber}` : "No CRO number", o.kind.replace("_", " ")]} status={o.status} id={o.id} />
          ))}
        </Section>
      )}
      {found?.jobs && (
        <Section title="Jobs" more={found.jobs.more} empty={found.jobs.items.length === 0}>
          {found.jobs.items.map((j) => (
            <Row key={j.id} title={j.title} meta={[j.employerName, j.county ?? "No county"]} status={j.status.replace("_", " ")} id={j.id} />
          ))}
        </Section>
      )}
      {found?.cases && (
        <Section title="Services cases" more={found.cases.more} empty={found.cases.items.length === 0} hint="A case is found by its number.">
          {found.cases.items.map((c) => (
            <Row key={c.id} title={`Case ${c.id}`} meta={[c.permitType.replace("_", " ")]} status={c.status.replace("_", " ")} id={c.id} />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, more, empty, hint, children }: { title: string; more: boolean; empty: boolean; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby={`s-${title.replace(/\W+/g, "")}`}>
      <h2 id={`s-${title.replace(/\W+/g, "")}`} className="text-[24px]">{title}</h2>
      {empty ? <p className="text-muted">{`No ${title.toLowerCase()} match. ${hint ?? "Try a different text."}`}</p> : <ul className="flex flex-col gap-3">{children}</ul>}
      {more && <p className="text-small text-muted">Showing the first 10. Type more of the text to narrow it down.</p>}
    </section>
  );
}

function Row({ title, meta, status, id }: { title: string; meta: string[]; status: string; id: string }) {
  return (
    <li>
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="font-semibold">{title}</p>
          <p className="text-small text-muted">{[...meta, `ID ${id}`].join(" · ")}</p>
        </div>
        <Pill tone="neutral">{status}</Pill>
      </Card>
    </li>
  );
}
