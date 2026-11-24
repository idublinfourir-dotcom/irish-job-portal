// A job that is no longer open (N03 closed state, C08 labels, #57): what happened in words, then similar live jobs. S20 codes only; never a report or staff note.
// Fed by the closed-job read (B27, `readClosedJob`) for anyone with the link, and for a signed-in candidate by the saved-or-tracked read (hidden and under review).
import { Breadcrumb, Button } from "@portal/ui";
import { TileCard, type CardJob } from "./card";
import { Hl, Join, wrap } from "./parts";

export const CLOSED_WORDS: Record<string, { label: string; tone: string; text: string }> = {
  under_review: { label: "Under review", tone: "bg-lilac text-ink", text: "The employer is checking this job. It is not shown for now. Come back later, or look at similar jobs below." },
  hidden_after_report: { label: "Hidden for now", tone: "bg-lilac text-ink", text: "We hide a job while we look at a report about it. Look at similar jobs below." },
  no_longer_available: { label: "This job has closed", tone: "bg-error-tint text-error", text: "It is no longer open for applications. Jobs like it are below." },
};
const wordsFor = (reason: string | null | undefined) => CLOSED_WORDS[reason ?? ""] ?? CLOSED_WORDS.no_longer_available!;

export function ClosedJob({ reason, title, employerName, similar, signedIn }: {
  reason: string | null | undefined; title?: string | null; employerName?: string | null; similar: CardJob[]; signedIn: boolean;
}) {
  const w = wordsFor(reason);
  return (
    <>
      <div className={`${wrap} pb-8 pt-6`}>
        <Breadcrumb items={[{ label: "Find a job", href: "/jobs" }, { label: title || "Job" }]} />
        <section data-closed-job className="mt-4 flex flex-col items-start gap-4 rounded-bento bg-sand p-6 sm:p-9">
          <span className={`inline-flex min-h-[34px] items-center rounded-pill px-3.5 text-small font-medium ${w.tone}`}>{w.label}</span>
          <h1 className="break-words text-[2.1rem] sm:text-[3.4rem]">{title || "This job"}</h1>
          {employerName && <p className="font-heading text-[18px] font-semibold">{employerName}</p>}
          <p className="max-w-xl text-muted">{w.text}</p>
          <Button href="/jobs">Find other jobs</Button>
        </section>
        {similar.length > 0 && (
          <section aria-labelledby="similar" className="mt-8 flex flex-col gap-4">
            <h2 id="similar" className="text-[26px] sm:text-[32px]">More jobs <Hl c="green">like this</Hl></h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{similar.slice(0, 3).map((j, i) => <TileCard key={j.id} job={j} dark={i > 0} />)}</div>
          </section>
        )}
      </div>
      {!signedIn && <Join />}
    </>
  );
}
