"use client";
// The buttons of one data request or one pending erase. They post to POST /api/data-requests (docs/openapi/admin.yaml). An erase cannot be undone, so its confirm
// names what goes; it needs a DIFFERENT administrator than the one who proposed it, and the proposer can only withdraw. Staff never receive the person's data:
// the export goes to the account owner by a link on their own site.
import { useState } from "react";
import { Button, Dialog, Notice } from "@portal/ui";
import { useAct, type ActState } from "../_tools/use-act";
import { ERASE_GOES } from "./text";

export type Ask = null | "close" | "erase_propose" | "erase_confirm";
export type ItemProps = { kind: "item"; itemId: string; email: string | null; canPropose: boolean };
export type EraseProps = { kind: "erase"; requestId: string; who: string; account: string; mine: boolean };
export type Handlers = { onAsk: (a: Ask) => void; onSend: (purpose: "export" | "erase") => void; onDo: (a: "close" | "erase_propose" | "erase_confirm" | "erase_refuse") => void };

const Names = ({ who, account }: { who: string; account: string }) => (
  <>
    <p className="mb-2">{`This erases the ${account} for ${who}, for good. It cannot be undone. It takes:`}</p>
    <ul className="mb-4 list-disc pl-5">{ERASE_GOES.map((g) => <li key={g}>{g}</li>)}</ul>
    <p className="mb-4">One audit row names both administrators. It is refused while the person has an open services case or an open report, or owns a company with other active members.</p>
  </>
);

export function ControlsView({ p, s, ask, h }: { p: ItemProps | EraseProps; s: ActState; ask: Ask; h: Handlers }) {
  const err = s.error && <Notice kind="error">{s.error}</Notice>;
  const close = () => h.onAsk(null);
  if (p.kind === "erase")
    return (
      <div className="flex flex-col gap-3">
        {err}
        <div className="flex flex-wrap gap-2">
          {p.mine ? (
            <Button type="button" variant="outline" onClick={() => h.onDo("erase_refuse")} disabled={s.pending}>Withdraw my erase</Button>
          ) : (
            <>
              <Button type="button" variant="danger" onClick={() => h.onAsk("erase_confirm")} disabled={s.pending}>Confirm the erase</Button>
              <Button type="button" variant="outline" onClick={() => h.onDo("erase_refuse")} disabled={s.pending}>Refuse</Button>
            </>
          )}
        </div>
        {!p.mine && (
          <Dialog open={ask === "erase_confirm"} onClose={close} title="Erase this account for good?">
            <Names who={p.who} account={p.account} />
            {err}
            <div className="mt-4 flex gap-2">
              <Button type="button" variant="danger" onClick={() => h.onDo("erase_confirm")} disabled={s.pending}>Erase the account</Button>
              <Button type="button" variant="outline" onClick={close}>Cancel</Button>
            </div>
          </Dialog>
        )}
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      {err}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => h.onSend("export")} disabled={s.pending}>Send the export link</Button>
        <Button type="button" variant="outline" onClick={() => h.onSend("erase")} disabled={s.pending}>Send the erase link</Button>
        {p.canPropose && <Button type="button" variant="danger" onClick={() => h.onAsk("erase_propose")} disabled={s.pending}>Propose an erase</Button>}
        <Button type="button" variant="outline" onClick={() => h.onAsk("close")} disabled={s.pending}>Close the request</Button>
      </div>
      <Dialog open={ask === "close"} onClose={close} title="Close this request?">
        <p className="mb-4">The request ends and any link sent for it stops working. Nothing is erased.</p>
        {err}
        <div className="mt-4 flex gap-2">
          <Button type="button" onClick={() => h.onDo("close")} disabled={s.pending}>Close the request</Button>
          <Button type="button" variant="outline" onClick={close}>Cancel</Button>
        </div>
      </Dialog>
      {p.canPropose && (
        <Dialog open={ask === "erase_propose"} onClose={close} title="Propose an erase?">
          <p className="mb-4">{`A second administrator must confirm before anything is erased. If they do, it takes: ${ERASE_GOES.join("; ")}. It cannot be undone.`}</p>
          {err}
          <div className="mt-4 flex gap-2">
            <Button type="button" variant="danger" onClick={() => h.onDo("erase_propose")} disabled={s.pending}>Propose the erase</Button>
            <Button type="button" variant="outline" onClick={close}>Cancel</Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

export function Controls(p: ItemProps | EraseProps) {
  const { s, send } = useAct("/api/data-requests");
  const [ask, setAsk] = useState<Ask>(null);
  const id = p.kind === "item" ? { itemId: p.itemId } : { requestId: p.requestId };
  const h: Handlers = {
    onAsk: setAsk,
    onSend: (purpose) => void send({ action: "send_confirm", ...id, purpose }),
    onDo: (a) => void send({ action: a, ...id }).then((r) => r.ok && setAsk(null)),
  };
  return <ControlsView p={p} s={s} ask={ask} h={h} />;
}
