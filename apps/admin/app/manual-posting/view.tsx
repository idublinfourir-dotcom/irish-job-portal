// Manual posting (frame D10) as parts that take their data as props. The form and checks are in form.tsx. Below them the staff member's own posts (an account reviewer) or every manual post
// (trust and safety, administrator, read only), with Close for one's own live post and the two-person "Sponsor confirmed" step: the account reviewer uploads the employer's written
// confirmation, a different administrator confirms or refuses it, and the proposer can only withdraw (the route refuses the same person confirming).
import type { ManualRow } from "@portal/db";
import { A, CriticalSkillsBadge, Notice, Pill, SponsorBadge } from "@portal/ui";
import { when } from "../_queue/age";
import { OpenCopy } from "../_queue/open-copy";
import { Head } from "../_queue/page-head";
import { PostButton } from "../_queue/post-button";
import { adminWords } from "../_queue/words-adm";
import { ManualForm, SponsorUpload, type Occ } from "./form";
import { statusLabel, type SponsorPending } from "./text";

export type Who = { id: string; roles: string[] };
const BACK = "/manual-posting";
const FILE = "/api/manual-jobs/sponsor-confirmation";

export function Sponsor({ row, pending, who }: { row: ManualRow; pending: SponsorPending | undefined; who: Who }) {
  if (row.status !== "live" || row.badge === "sponsor_confirmed") return null;
  const reviewer = who.roles.includes("account_reviewer"), admin = who.roles.includes("administrator");
  if (row.sponsor_request_id === null) return reviewer ? <SponsorUpload jobId={row.id} back={BACK} /> : null;
  if (!pending) return <p className="text-small text-muted">A confirmation waits for an administrator.</p>;
  const mine = pending.proposedBy === who.id;
  return (
    <div className="flex flex-col gap-2 rounded-card bg-lilac-soft p-3">
      <p className="text-small"><span className="font-semibold">Sponsor confirmed waits for a different administrator.</span> Uploaded by {mine ? "you" : (pending.proposedByName ?? "a person")}: <span className="[overflow-wrap:anywhere]">{pending.fileName}</span></p>
      <OpenCopy url={`${FILE}?requestId=${encodeURIComponent(pending.requestId)}`} name={pending.fileName} />
      {mine && <p className="text-small">You cannot confirm your own upload. You can withdraw it.</p>}
      <div className="flex flex-wrap gap-2">
        {admin && !mine && <PostButton url={FILE} body={{ action: "confirm", requestId: pending.requestId }} label="Confirm" back={BACK} confirm={{ title: "Confirm Sponsor confirmed?", text: `The post "${row.title}" shows Sponsor confirmed at once, on the employer's written confirmation.`, button: "Confirm" }} />}
        {(admin && !mine) && <PostButton url={FILE} body={{ action: "refuse", requestId: pending.requestId }} label="Refuse" variant="chip" back={BACK} confirm={{ title: "Refuse this confirmation?", text: "The file is removed and the post stays as it is.", button: "Refuse" }} />}
        {mine && <PostButton url={FILE} body={{ action: "refuse", requestId: pending.requestId }} label="Withdraw" variant="chip" back={BACK} confirm={{ title: "Withdraw the upload?", text: "The file is removed.", button: "Withdraw" }} />}
      </div>
    </div>
  );
}

export function Posts({ items, who, sponsor, next, prev, own }: { items: ManualRow[]; who: Who; sponsor: SponsorPending[]; next?: string; prev?: string; own: boolean }) {
  return (
    <section aria-label={own ? "Your posts" : "Manual posts"} className="flex flex-col gap-3">
      <h2 className="text-[22px]">{own ? "Your posts" : "Manual posts"}</h2>
      {items.length === 0 && <p className="text-small text-muted">{own ? "You have not posted a job by hand yet." : "No job has been posted by hand yet."}</p>}
      <ul className="flex flex-col gap-3">
        {items.map((r) => (
          <li key={r.id} className="flex flex-col gap-2 rounded-card border border-line bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0"><p className="font-semibold [overflow-wrap:anywhere]">{r.title}</p><p className="text-small text-muted [overflow-wrap:anywhere]">{r.display_name}</p></div>
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={r.status === "live" ? "green" : r.status === "draft" ? "peach" : "neutral"} className="min-h-[30px]">{statusLabel(r.status)}</Pill>
                {r.badge === "critical_skills_eligible" && <CriticalSkillsBadge />}{r.badge === "sponsor_confirmed" && <SponsorBadge />}
              </div>
            </div>
            <p className="text-small text-muted">Posted {when(r.posted_at)} · closes {when(r.closes_at)}{r.closed_at ? ` · closed ${when(r.closed_at)}` : ""}</p>
            {r.status === "draft" && r.reason && <p className="text-small">Not listed: {adminWords(r.reason, 400)}</p>}
            <Sponsor row={r} pending={sponsor.find((s) => s.requestId === r.sponsor_request_id)} who={who} />
            {r.status === "live" && r.posted_by_staff_id === who.id && (
              <div><PostButton url="/api/manual-jobs" body={{ action: "close", jobId: r.id }} label="Close this post" variant="chip" back={BACK} confirm={{ title: "Close this post?", text: `"${r.title}" is taken down and cannot be reopened.`, button: "Close it" }} /></div>
            )}
          </li>
        ))}
      </ul>
      <div className="flex gap-3 text-small font-semibold">{prev && <A href={prev}>Previous</A>}{next && <A href={next}>Next</A>}</div>
    </section>
  );
}

export type ManualPageProps = { who: Who; items: ManualRow[]; sponsor: SponsorPending[]; next?: string; prev?: string; form?: { occupations: Occ[]; hours: number; today: string; last: string } };
export function ManualPosting(p: ManualPageProps) {
  const reviewer = p.who.roles.includes("account_reviewer");
  return (
    <div className="flex flex-col gap-6">
      <Head title="Manual posting">Post a job for any employer. The same rule checks run as in the employer form.</Head>
      {reviewer && p.form ? <ManualForm {...p.form} /> : <Notice kind="info">Only an account reviewer posts a job. You can read the posts and, as an administrator, confirm a Sponsor confirmed request.</Notice>}
      <Posts items={p.items} who={p.who} sponsor={p.sponsor} next={p.next} prev={p.prev} own={reviewer} />
    </div>
  );
}
