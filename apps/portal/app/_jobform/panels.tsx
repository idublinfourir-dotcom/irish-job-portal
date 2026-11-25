// The right-hand column of the posting form (frames NE3, E10): the live checks list and the first-time sponsor card. Presentational: props from the checks route, so a test renders every state.
import { Icon, Notice, Pill } from "@portal/ui";
import { blockedCount, rowOf, type Check, type Row } from "./model";

const MARK: Record<Row["state"], { icon: "check" | "warning" | "close"; box: string }> = {
  pass: { icon: "check", box: "bg-deep-green text-white" }, note: { icon: "warning", box: "bg-peach text-ink" }, blocked: { icon: "close", box: "bg-error text-white" },
};

/** `checks` is null until the form is complete enough to check. `error` is the sentence for a check that could not run. */
export function ChecksPanel({ checks, missing, checking, error }: { checks: readonly Check[] | null; missing: string[]; checking?: boolean; error?: string }) {
  const rows = (checks ?? []).map(rowOf), blocked = checks ? blockedCount(checks) : 0;
  return (
    <section aria-labelledby="checks-h" aria-busy={checking || undefined} data-card="checks" className="flex flex-col gap-4 rounded-bento bg-sand p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 id="checks-h" className="text-xl">Live checks</h2>
        {checks && <Pill tone={blocked ? "lilac" : "green"}>{blocked ? `${blocked} blocked` : "All clear"}</Pill>}
      </div>
      {error && <Notice kind="warning">{error}</Notice>}
      {!checks ? (
        <p className="text-muted" data-checks-waiting>{missing.length ? `The checks run when these are filled in: ${missing.join(", ")}.` : "The checks run as soon as you stop typing."}</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((r) => (
            <li key={r.id} data-check={r.id} data-state={r.state} className="flex items-start gap-3 border-t border-line py-3 first:border-0">
              <span aria-hidden="true" className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-pill ${MARK[r.state].box}`}><Icon name={MARK[r.state].icon} size={14} /></span>
              <span><span className="block font-semibold">{r.title}<span className="sr-only">{r.state === "pass" ? ", passed" : r.state === "note" ? ", a person will look" : ", blocked"}</span></span><span className="text-small text-muted">{r.text}</span></span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export const FirstTimeCard = () => (
  <section data-card="first-time" className="rounded-bento bg-ink p-6 text-white">
    <h2 className="text-xl text-white">First-time sponsor</h2>
    <p className="mt-2 text-white/80">Your jobs carry this label until our team links your first permit to your company in the permit records.</p>
  </section>
);
