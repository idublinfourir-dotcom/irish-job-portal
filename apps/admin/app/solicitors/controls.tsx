"use client";
// The administrator's controls on the solicitor list: add a firm, edit one, deactivate one (nothing is deleted). They post to POST /api/services/solicitors
// (docs/openapi/admin.yaml). A services case handler reads the list and sees none of these.
import { useState } from "react";
import { Button, Input, Notice } from "@portal/ui";
import { useAct, type ActState } from "../_tools/use-act";

export type Draft = { firm: string; contact: string };
export type Handlers = { onField: (d: Partial<Draft>) => void; onSave: () => void; onDeactivate?: () => void };

export function FirmFormView({ s, draft, adding, h }: { s: ActState; draft: Draft; adding: boolean; h: Handlers }) {
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (!s.pending) h.onSave(); }}>
      {s.error && <Notice kind="error">{s.error}</Notice>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Firm" name="firm" required maxLength={200} value={draft.firm} onChange={(e) => h.onField({ firm: e.target.value })} />
        <Input label="Contact" name="contact" required maxLength={300} value={draft.contact} onChange={(e) => h.onField({ contact: e.target.value })} help="An email address or a phone number." />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={adding ? "primary" : "outline"} disabled={s.pending}>{adding ? "Add the firm" : "Save"}</Button>
        {h.onDeactivate && <Button type="button" variant="outline" onClick={h.onDeactivate} disabled={s.pending}>Deactivate</Button>}
      </div>
    </form>
  );
}

/** `firm` undefined: the add form. Otherwise the edit form of that firm. */
export function FirmForm({ id, firm, contact }: { id?: string; firm?: string; contact?: string }) {
  const { s, send } = useAct("/api/services/solicitors");
  const [draft, set] = useState<Draft>({ firm: firm ?? "", contact: contact ?? "" });
  const h: Handlers = {
    onField: (d) => set((o) => ({ ...o, ...d })),
    onSave: () => void send(id ? { action: "edit", solicitorId: id, firm: draft.firm, contact: draft.contact } : { action: "add", firm: draft.firm, contact: draft.contact }).then((r) => r.ok && !id && set({ firm: "", contact: "" })),
    onDeactivate: id ? () => void send({ action: "deactivate", solicitorId: id }) : undefined,
  };
  return <FirmFormView s={s} draft={draft} adding={!id} h={h} />;
}
