// The accounts page (C3, C6): suspend, block or lift a login, and merge two candidate accounts with a second administrator. Administrators only. Every action needs a
// sign-in from the last 10 minutes (reauth_required sends the person to sign in again and back here).
import { EmptyState, Notice } from "@portal/ui";
import { Act } from "../_queue/act";
import { ageText, when } from "../_queue/age";
import { Head } from "../_queue/page-head";
import { HOLDS } from "./text";

export type Merge = { requestId: string; keep: string; drop: string; proposedBy: string; createdAt: string };
export const HERE = "/accounts";
const idField = (label: string, name = "userId") => ({ name, label, kind: "text" as const, maxLength: 64, required: true, help: "Paste the login id exactly as the report or case shows it." });

export function Holds() {
  return (
    <section aria-label="Suspend, block and lift" className="grid gap-6 md:grid-cols-2">
      {HOLDS.map((h) => (
        <div key={h.action} className="flex flex-col gap-3 rounded-card bg-sand p-5">
          <h2 className="text-[19px]">{h.label}</h2>
          <Act url="/api/accounts" fixed={{ action: h.action }} fields={[idField("Login id"), { name: "reason", label: "Reason", kind: "select", options: h.reasons }]} label={h.label} variant={h.danger ? "danger" : "primary"} here={HERE} confirm={h.confirm} />
        </div>
      ))}
    </section>
  );
}

export function Merges({ pending, meId, now }: { pending: Merge[]; meId: string; now: Date }) {
  return (
    <section aria-label="Candidate account merges" className="flex flex-col gap-4">
      <h2 className="text-[22px]">Merge two candidate accounts</h2>
      <p className="text-muted">One person with two logins. You propose the merge and a different administrator confirms it. The account to drop is erased once its rows have moved, and this cannot be undone.</p>
      <div className="rounded-card bg-sand p-5">
        <Act
          url="/api/accounts" fixed={{ action: "merge_propose" }} label="Propose the merge" here={HERE}
          fields={[idField("Login id to keep", "keep"), idField("Login id to drop", "drop")]}
        />
      </div>
      {pending.length === 0 ? <EmptyState icon="users" title="No merge is waiting">A merge you propose waits here for a second administrator.</EmptyState> : (
        <ul className="flex flex-col gap-3">
          {pending.map((m) => (
            <li key={m.requestId} className="flex flex-col gap-3 rounded-card border border-line bg-white p-5">
              <p className="text-small [overflow-wrap:anywhere]">Keep <b>{m.keep}</b>, drop <b>{m.drop}</b>. Proposed {when(m.createdAt)} ({ageText(m.createdAt, now)} ago){m.proposedBy === meId ? " by you." : "."}</p>
              {m.proposedBy === meId ? (
                <>
                  <Notice kind="info">You proposed this merge. A different administrator has to confirm it. You can withdraw it.</Notice>
                  <Act url="/api/accounts" fixed={{ action: "merge_refuse", requestId: m.requestId }} label="Withdraw" variant="outline" here={HERE} />
                </>
              ) : (
                <div className="flex flex-wrap gap-4">
                  <Act url="/api/accounts" fixed={{ action: "merge_confirm", requestId: m.requestId }} label="Confirm the merge" variant="danger" here={HERE} confirm="Confirm the merge? The dropped account's rows move to the kept one and the dropped account is erased. This cannot be undone." />
                  <Act url="/api/accounts" fixed={{ action: "merge_refuse", requestId: m.requestId }} label="Refuse" variant="outline" here={HERE} confirm="Refuse this merge? Nothing moves." />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Accounts({ pending, meId, now }: { pending: Merge[]; meId: string; now: Date }) {
  return (
    <div className="flex flex-col gap-8">
      <Head title="Accounts">Suspend a candidate login, block an employer or agency login, lift either, and merge two candidate accounts. Administrators only.</Head>
      <Notice kind="info">Every action here needs a sign-in from the last 10 minutes. If yours is older you are asked to sign in again and brought back to this page. An appeal comes in through the contact form. Every action is written to the audit log.</Notice>
      <Holds />
      <Merges pending={pending} meId={meId} now={now} />
    </div>
  );
}
