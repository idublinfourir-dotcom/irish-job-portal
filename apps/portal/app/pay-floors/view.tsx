// DD33: the pay floor page of a big-company signer: the wording to sign, the form, and the floors signed with their status, end date and Withdraw. Presentational (props from the read).
import { EmptyState, Notice, Pill } from "@portal/ui";
import { dateWord } from "../_jobs/words";
import { SignFloor, Withdraw } from "./forms";

export type FloorText = { id: string; version: string; body: string };
export type Floor = { id: string; roleFamily: string; floorEur: number; status: string; signedAt: string; validUntil: string; endedAt: string | null; signerName: string | null; signerTitle: string | null };

export const FLOOR_STATUS: Record<string, string> = { pending_check: "Waiting for a check", active: "Active", withdrawn: "Withdrawn", rejected: "Not approved", replaced: "Replaced by a newer floor", expired: "Ended", found_false: "Withdrawn by our team" };
const EUR = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const th = "px-4 py-3 text-left text-small font-semibold";

export function PayFloorsView({ canSign, text, floors }: { canSign: boolean; text: FloorText | null; floors?: Floor[] }) {
  return (
    <div className="mx-auto flex max-w-page flex-col gap-6">
      <header><h1>Pay floors</h1><p className="mt-2 max-w-2xl text-muted">A company on the big-company list can promise to pay at least a set amount for a role family for 12 months. Our team checks each floor before a job can use it.</p></header>
      <section aria-labelledby="sign-h" className="flex flex-col gap-4 rounded-bento bg-sand p-6">
        <h2 id="sign-h" className="text-xl">Sign a pay floor</h2>
        {text ? <blockquote data-floor-wording className="whitespace-pre-line rounded-card bg-white p-4">{text.body}</blockquote> : <Notice kind="info" title="No wording is published yet">A pay floor cannot be signed until the wording is published. Try again later.</Notice>}
        {canSign ? <SignFloor textId={text?.id ?? null} /> : <Notice kind="info">Your role can read pay floors but not sign them. Ask the account owner or a signer.</Notice>}
      </section>
      <section aria-labelledby="signed-h" className="flex flex-col gap-3">
        <h2 id="signed-h" className="text-xl">Floors you signed</h2>
        {!floors ? <Notice kind="error" title="We cannot show your pay floors now">Reload the page in a minute.</Notice> : floors.length === 0 ? <EmptyState icon="euro" title="No pay floors yet">A floor you sign shows here with its status.</EmptyState> : (
          <div className="relative overflow-x-auto rounded-bento border border-line bg-white">
            <table className="w-full min-w-[40rem] border-collapse text-small">
              <caption className="sr-only">Pay floors</caption>
              <thead className="bg-lilac-soft"><tr><th scope="col" className={th}>Role family</th><th scope="col" className={th}>Floor</th><th scope="col" className={th}>Status</th><th scope="col" className={th}>Signed by</th><th scope="col" className={th}>Valid until</th><th scope="col" className={th}><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {floors.map((f) => (
                  <tr key={f.id} data-floor={f.id} className="border-t border-line">
                    <td className="px-4 py-3">{f.roleFamily}</td>
                    <td className="px-4 py-3 tabular-nums">{EUR.format(f.floorEur)}</td>
                    <td className="px-4 py-3"><Pill tone={f.status === "active" ? "green" : f.status === "pending_check" ? "peach" : "neutral"}>{FLOOR_STATUS[f.status] ?? "Ended"}</Pill></td>
                    <td className="px-4 py-3">{[f.signerName, f.signerTitle].filter(Boolean).join(", ") || "Not shown"}<span className="block text-muted">{dateWord(f.signedAt)}</span></td>
                    <td className="px-4 py-3">{dateWord(f.endedAt ?? f.validUntil)}</td>
                    <td className="px-4 py-3">{canSign && (f.status === "pending_check" || f.status === "active") && <Withdraw id={f.id} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
