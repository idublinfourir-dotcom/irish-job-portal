"use client";
// Marks one scheduled reminder done: POST /api/scheduled-checks { action: "done", itemId } (docs/openapi/admin.yaml). The route checks the role and that the
// reminder is one of the member's roles, and writes the audit row.
import { Button, Notice } from "@portal/ui";
import { useAct, type ActState } from "../_tools/use-act";

export function DoneView({ s, onDone }: { s: ActState; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      {s.error && <Notice kind="error">{s.error}</Notice>}
      <Button type="button" variant="outline" onClick={onDone} disabled={s.pending} className="self-start">Mark done</Button>
    </div>
  );
}
export function DoneButton({ itemId }: { itemId: string }) {
  const { s, send } = useAct("/api/scheduled-checks");
  return <DoneView s={s} onDone={() => void send({ action: "done", itemId })} />;
}
