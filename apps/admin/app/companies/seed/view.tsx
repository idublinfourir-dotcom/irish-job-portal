// The company seed import (Q14): a rules data editor proposes a file, an administrator who did not propose it confirms and the import runs at once. The names in
// the rows are typed in a file by staff: text only.
import { EmptyState, Notice } from "@portal/ui";
import { Act } from "../../_queue/act";
import { ageText, when } from "../../_queue/age";
import { Head } from "../../_queue/page-head";

export type SeedRow = { line: number; displayName: string; kind: string; brandNames: string[]; deteNames: string[] };
export type Pending = { requestId: string; proposedBy: string; createdAt: string; rows: SeedRow[] };
export const HERE = "/companies/seed";
export const SHOWN_ROWS = 200;
export const MAX_SEED_TEXT = 1_000_000; // the route's cap on the file, in characters (docs/openapi/admin.yaml: bad_text)
const URL = "/api/companies/seed";

export function Rows({ rows }: { rows: SeedRow[] }) {
  return (
    <div className="overflow-x-auto rounded-card border border-line">
      <table className="w-full text-left text-small">
        <thead className="bg-lilac"><tr><th className="px-3 py-2">Line</th><th className="px-3 py-2">Company</th><th className="px-3 py-2">Kind</th><th className="px-3 py-2">Brand names</th><th className="px-3 py-2">DETE names</th></tr></thead>
        <tbody>
          {rows.slice(0, SHOWN_ROWS).map((r) => (
            <tr key={r.line} className="border-t border-line align-top">
              <td className="px-3 py-2">{r.line}</td><td className="px-3 py-2 [overflow-wrap:anywhere]">{r.displayName}</td><td className="px-3 py-2">{r.kind.replaceAll("_", " ")}</td>
              <td className="px-3 py-2 [overflow-wrap:anywhere]">{r.brandNames.join(", ") || "None"}</td><td className="px-3 py-2 [overflow-wrap:anywhere]">{r.deteNames.join(", ") || "None"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > SHOWN_ROWS && <p className="border-t border-line px-3 py-2 text-small text-muted">The first {SHOWN_ROWS} of {rows.length} rows are shown. The whole file is imported.</p>}
    </div>
  );
}

export function PendingImport({ p, meId, canDecide, now }: { p: Pending; meId: string; canDecide: boolean; now: Date }) {
  const mine = p.proposedBy === meId;
  return (
    <section aria-label="Pending import" className="flex flex-col gap-4 rounded-card bg-sand p-5 sm:p-6">
      <h2 className="text-[22px]">Waiting for an administrator</h2>
      <p className="text-small text-muted">{p.rows.length} {p.rows.length === 1 ? "company" : "companies"} · proposed {when(p.createdAt)} ({ageText(p.createdAt, now)} ago){mine ? " by you" : ""}</p>
      <Rows rows={p.rows} />
      {mine && <Notice kind="info">You proposed this file. A different administrator has to confirm it. You can withdraw it.</Notice>}
      {!mine && !canDecide && <Notice kind="info">An administrator confirms or refuses this file.</Notice>}
      <div className="flex flex-wrap gap-4">
        {!mine && canDecide && <Act url={URL} fixed={{ action: "confirm", requestId: p.requestId }} label="Confirm and import" here={HERE} confirm={`Import these ${p.rows.length} companies now? Existing companies keep their data and gain the names.`} />}
        {(mine || canDecide) && <Act url={URL} fixed={{ action: "refuse", requestId: p.requestId }} label={mine ? "Withdraw" : "Refuse"} variant="outline" here={HERE} confirm={mine ? "Withdraw this file?" : "Refuse this file? Nothing is imported."} />}
      </div>
    </section>
  );
}

export function Seed({ pending, meId, canPropose, canDecide, now }: { pending: Pending[]; meId: string; canPropose: boolean; canDecide: boolean; now: Date }) {
  return (
    <div className="flex flex-col gap-6">
      <Head title="Company seed">A list of checked companies with their brand names and DETE names. A rules data editor proposes a file and a different administrator confirms it.</Head>
      {pending.length === 0 ? <EmptyState icon="building" title="No import is waiting">A file that is proposed appears here for a second person.</EmptyState> : pending.map((p) => <PendingImport key={p.requestId} p={p} meId={meId} canDecide={canDecide} now={now} />)}
      {canPropose && (
        <section aria-label="Propose a file" className="flex flex-col gap-3 rounded-card bg-sand p-5 sm:p-6">
          <h2 className="text-[22px]">Propose a file</h2>
          <Act
            url={URL} fixed={{ action: "propose" }} label="Propose this file" here={HERE}
            fields={[{ name: "text", label: "The file", kind: "textarea", maxLength: MAX_SEED_TEXT, required: true, help: "Tab-separated. The first line is: display_name, kind, brand_names, dete_names. The kind is employer, public_body or agency. Several names in one cell are separated by a space, two semicolons and a space. Up to 2,000 companies. One bad line refuses the whole file." }]}
          />
        </section>
      )}
      {!canPropose && <Notice kind="info">Only a rules data editor can propose a file.</Notice>}
    </div>
  );
}
