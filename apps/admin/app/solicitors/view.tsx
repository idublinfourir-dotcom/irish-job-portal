// The referral solicitor list (S-Q10 B) as parts that take their data as props. A services case handler and an administrator read it; only an administrator
// adds, edits or deactivates a firm (nothing is deleted).
import { EmptyState, Pill } from "@portal/ui";
import { when } from "../_tools/text";
import { FirmForm } from "./controls";

export type Firm = { id: string; firm: string; contact: string; active: boolean; createdAt: string };

export function Solicitors({ items, isAdmin }: { items: Firm[]; isAdmin: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="mb-1 text-[32px] leading-tight md:text-[34px]">Solicitors</h1>
        <p className="text-muted">The firms a services case can be referred to. Active firms come first. A firm is deactivated, never deleted.</p>
      </header>
      {isAdmin && (
        <section aria-label="Add a firm" className="flex flex-col gap-3 rounded-bento bg-sand p-5">
          <h2 className="text-[22px]">Add a firm</h2>
          <FirmForm />
        </section>
      )}
      {items.length === 0 && <EmptyState icon="building" title="No firm on the list yet">{isAdmin ? "Add the first firm above." : "An administrator adds the firms."}</EmptyState>}
      <ul className="flex flex-col gap-4">
        {items.map((f) => (
          <li key={f.id} className="flex flex-col gap-3 rounded-bento bg-sand p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[22px] [overflow-wrap:anywhere]">{f.firm}</h2>
              <Pill tone={f.active ? "green" : "white"}>{f.active ? "Active" : "Not active"}</Pill>
            </div>
            <p className="text-small text-muted [overflow-wrap:anywhere]">{`${f.contact} · added ${when(f.createdAt)}`}</p>
            {isAdmin && f.active && <FirmForm id={f.id} firm={f.firm} contact={f.contact} />}
          </li>
        ))}
      </ul>
    </div>
  );
}
