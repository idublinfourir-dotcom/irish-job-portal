"use client";
// The decision part of the fetched-job detail card: the occupation code (SOC) picker, the contract and pay the reviewer confirms, "Check this code" (a plain GET
// form back to the page, which runs the dry run), then Approve and publish and Reject, each after a confirm. They post to POST /api/fetched-jobs
// (docs/openapi/admin.yaml): the route checks the role, the claim and the Origin again, re-runs the rules and writes the audit row (with the old and new code).
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Checkbox, Dialog, Input, Notice, Select } from "@portal/ui";
import { errorWords } from "../_queue/messages";
import { postJson } from "../_queue/post";
import { REJECT_REASONS } from "./text";

export type SocOption = { code: string; title: string };
export type Props = {
  itemId: string; status: string; mine: boolean; stage?: string; socOptions: SocOption[]; soc: string; contract: boolean; low?: number; high?: number;
  /** The queue as the reviewer had it (stage tab), the page to go back to after a decision. */
  listHref: string;
};
export type Ask = null | "approve" | "reject";
export type ViewState = { ask: Ask; pending: boolean; error?: string; soc: string; contract: boolean; low: string; high: string; reason: string };
export type Handlers = { onClaim: () => void; onRelease: () => void; onAsk: (a: Ask) => void; onConfirm: () => void; onChange: (patch: Partial<ViewState>) => void };

export function ActionsView({ p, s, h }: { p: Props; s: ViewState; h: Handlers }) {
  if (p.status === "done") return <p className="text-small text-muted">This item is decided. Every decision is written to the audit log.</p>;
  const err = s.error && <Notice kind="error">{s.error}</Notice>;
  if (!p.mine)
    return (
      <div className="flex flex-col gap-3">
        {err}
        <p className="text-small text-muted">{p.status === "claimed" ? "Another reviewer holds this item." : "Claim this item to decide it."}</p>
        <Button type="button" onClick={h.onClaim} disabled={s.pending} className="self-start">{p.status === "claimed" ? "Take over the claim" : "Claim this job"}</Button>
      </div>
    );
  const known = p.socOptions.some((o) => o.code === s.soc);
  return (
    <form action="/fetched-jobs" method="get" className="flex flex-col gap-4" onSubmit={(e) => { if (s.pending) e.preventDefault(); }}>
      <input type="hidden" name="id" value={p.itemId} />
      {p.stage !== undefined && <input type="hidden" name="stage" value={p.stage} />}
      {err}
      <Select label="SOC code" name="soc" value={s.soc} onChange={(e) => h.onChange({ soc: e.target.value })} help="Only codes on the Critical Skills list can be published. The code you pick is saved when you approve; the audit log keeps the old and the new code.">
        {s.soc === "" && <option value="">Pick a code</option>}
        {!known && s.soc !== "" && <option value={s.soc}>{`${s.soc} (not on the Critical Skills list)`}</option>}
        {p.socOptions.map((o) => <option key={o.code} value={o.code}>{`${o.code} · ${o.title}`}</option>)}
      </Select>
      <Checkbox label="The contract is at least 2 years" name="contract" value="1" checked={s.contract} onChange={(e) => h.onChange({ contract: e.target.checked })} help="Tick it only after reading the advert, when the rules could not tell." />
      <div className="grid grid-cols-2 gap-3">
        <Input label="Pay from (euro a year)" name="low" inputMode="numeric" pattern="[0-9]{1,7}" maxLength={7} value={s.low} onChange={(e) => h.onChange({ low: e.target.value })} />
        <Input label="Pay to" name="high" inputMode="numeric" pattern="[0-9]{1,7}" maxLength={7} value={s.high} onChange={(e) => h.onChange({ high: e.target.value })} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => h.onAsk("approve")} disabled={s.pending || s.soc === ""}>Approve and publish</Button>
        <Button type="submit" variant="outline" disabled={s.pending || s.soc === ""}>Check this SOC code</Button>
        <Button type="button" variant="danger" onClick={() => h.onAsk("reject")} disabled={s.pending}>Reject</Button>
        <Button type="button" variant="outline" onClick={h.onRelease} disabled={s.pending}>Release</Button>
      </div>
      <Dialog open={s.ask !== null} onClose={() => h.onAsk(null)} title={s.ask === "reject" ? "Reject this job?" : "Publish this job?"}>
        {s.ask === "reject" ? (
          <div className="mb-4 flex flex-col gap-3">
            <p>The job is closed and never shown to candidates.</p>
            <Select label="Reason for Reject" value={s.reason} onChange={(e) => h.onChange({ reason: e.target.value })}>
              {REJECT_REASONS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </Select>
          </div>
        ) : (
          <p className="mb-4">{`The job goes live with SOC code ${s.soc} and the Critical Skills eligible badge. The rules are run once more when you confirm.`}</p>
        )}
        {err}
        <div className="mt-4 flex gap-2">
          <Button type="button" variant={s.ask === "reject" ? "danger" : "primary"} onClick={h.onConfirm} disabled={s.pending}>{s.ask === "reject" ? "Reject" : "Approve and publish"}</Button>
          <Button type="button" variant="outline" onClick={() => h.onAsk(null)}>Cancel</Button>
        </div>
      </Dialog>
    </form>
  );
}

const euros = (v: string): number | undefined => (/^\d{1,7}$/.test(v.trim()) ? Number(v.trim()) : undefined);

export function Actions(p: Props) {
  const router = useRouter();
  const [s, set] = useState<ViewState>({ ask: null, pending: false, soc: p.soc, contract: p.contract, low: p.low?.toString() ?? "", high: p.high?.toString() ?? "", reason: REJECT_REASONS[0]![0] });
  const patch = (x: Partial<ViewState>) => set((o) => ({ ...o, ...x }));
  async function send(body: object, leave: boolean) {
    patch({ pending: true, error: undefined });
    const r = await postJson("/api/fetched-jobs", { itemId: p.itemId, ...body });
    if (!r.ok) return patch({ pending: false, error: errorWords(r.error, r.status, r.stage) });
    patch({ pending: false, ask: null });
    if (leave) router.replace(p.listHref);
    router.refresh();
  }
  const handlers: Handlers = {
    onClaim: () => void send({ action: "claim" }, false),
    onRelease: () => void send({ action: "release" }, true),
    onAsk: (ask) => patch({ ask, error: undefined }),
    onChange: patch,
    onConfirm: () => {
      if (s.ask === "reject") return void send({ action: "reject", reason: s.reason }, true);
      const low = euros(s.low), high = euros(s.high);
      if ((s.low.trim() !== "" && low === undefined) || (s.high.trim() !== "" && high === undefined)) return patch({ error: errorWords("bad_salary", 400) });
      void send({ action: "approve", occupationCode: s.soc, ...(low !== undefined ? { salaryLow: low } : {}), ...(high !== undefined ? { salaryHigh: high } : {}), ...(s.contract ? { contractConfirmed: true } : {}) }, true);
    },
  };
  return <ActionsView p={p} s={s} h={handlers} />;
}
