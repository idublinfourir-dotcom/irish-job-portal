"use client";
// The staff forms (frame D14): invite a login, propose a role. Each posts to POST /api/staff (docs/openapi/admin.yaml): administrators only, a sign-in from the last 10 minutes
// (C4), and a second administrator confirms every grant. The other buttons of the page are PostButtons. The views take their state as props so a test renders every state.
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Dialog, Input, Notice, Select } from "@portal/ui";
import { Failure } from "../_queue/failure";
import { postJson } from "../_queue/post";
import { ROLES, roleLabel } from "./matrix";

export type Failed = { code: string; status: number; staffId?: string } | null;
const roleOptions = (held: string[] = []) => ROLES.filter((r) => !held.includes(r)).map((r) => <option key={r} value={r}>{roleLabel(r)}</option>);

export function InviteView({ open, pending, failed, sent, onOpen, onClose, onSubmit }: { open: boolean; pending: boolean; failed: Failed; sent: boolean; onOpen: () => void; onClose: () => void; onSubmit: (e: FormEvent<HTMLFormElement>) => void }) {
  return (
    <>
      <Button type="button" onClick={onOpen}>Invite staff</Button>
      <Dialog open={open} onClose={onClose} title="Invite a staff member">
        {sent ? (
          <div className="flex flex-col gap-4">
            <Notice kind="success" title="The invitation is sent">They get an email to set a password. The role starts when a different administrator confirms it.</Notice>
            <Button type="button" variant="outline" onClick={onClose}>Close</Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <Input label="Name" name="name" required maxLength={100} autoComplete="off" />
            <Input label="Email" name="email" type="email" required maxLength={254} autoComplete="off" />
            <Select label="Role to propose" name="role" defaultValue="account_reviewer">{roleOptions()}</Select>
            {failed && <Failure code={failed.code} status={failed.status} back="/staff" />}
            <div className="flex gap-2">
              <Button type="submit" disabled={pending}>{pending ? "Sending" : "Send the invitation"}</Button>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}

export function InviteForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false), [sent, setSent] = useState(false), [failed, setFailed] = useState<Failed>(null);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setPending(true); setFailed(null);
    const r = await postJson("/api/staff", { action: "invite", name: String(f.get("name") ?? "").trim(), email: String(f.get("email") ?? "").trim(), role: String(f.get("role") ?? "") });
    setPending(false);
    if (!r.ok) {
      if (r.error === "email_not_sent") router.refresh(); // the login and its request are kept: Resend invite is on its row
      return setFailed({ code: r.error, status: r.status });
    }
    setSent(true);
    router.refresh();
  }
  return <InviteView open={open} pending={pending} failed={failed} sent={sent} onOpen={() => { setSent(false); setFailed(null); setOpen(true); }} onClose={() => setOpen(false)} onSubmit={(e) => void onSubmit(e)} />;
}

export function RoleFormView({ held, name, pending, failed, onSubmit }: { held: string[]; name: string; pending: boolean; failed: Failed; onSubmit: (e: FormEvent<HTMLFormElement>) => void }) {
  const options = roleOptions(held);
  if (options.length === 0) return <p className="text-small text-muted">Holds every role.</p>;
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Select label={`Propose a role for ${name}`} name="role" defaultValue={ROLES.find((r) => !held.includes(r))}>{options}</Select>
        <Button type="submit" variant="chip" size="md" disabled={pending}>Propose</Button>
      </div>
      {failed && <Failure code={failed.code} status={failed.status} back="/staff" />}
    </form>
  );
}

export function RoleForm({ staffId, name, held }: { staffId: string; name: string; held: string[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false), [failed, setFailed] = useState<Failed>(null);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true); setFailed(null);
    const r = await postJson("/api/staff", { action: "propose_role", staffId, role: String(new FormData(e.currentTarget).get("role") ?? "") });
    setPending(false);
    if (!r.ok) return setFailed({ code: r.error, status: r.status });
    router.refresh();
  }
  return <RoleFormView held={held} name={name} pending={pending} failed={failed} onSubmit={(e) => void onSubmit(e)} />;
}
