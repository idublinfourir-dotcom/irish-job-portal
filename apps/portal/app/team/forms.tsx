"use client";
// Frame E19 (DD17): the team list, the invite form, join requests, a role change, remove, resend and transfer. Each action is one call to POST /api/portal/team (docs/openapi/portal.yaml).
// Only the account owner gets the buttons (CF89: the owner, and the person who posted a job, are told of strikes); the route refuses everyone else too. A route that answers
// REAUTH_REQUIRED sends the person to sign in again and back here (DD10, CF129).
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Checkbox, Icon, Input, Notice, Select } from "@portal/ui";
import { reauth, send } from "../_account/client";
import { day, initials, INVITE_ROLES, needsReauth, ROLE_HELP, ROLE_LABEL, say } from "../_account/messages";

export type Member = { membershipId: string; name: string | null; email: string; role: string; isSigner: boolean; lastActiveAt: string | null };
export type Invite = { membershipId: string; email: string; role: string; isSigner: boolean; invitedAt: string; expiresAt: string };
export type JoinRequest = { membershipId: string; name: string | null; email: string };
export type Team = { members: Member[]; invites: Invite[]; requests: JoinRequest[] };
/** Runs one action; resolves true when it worked. `done` is the line shown after. */
export type Act = (body: Record<string, unknown>, done?: string) => Promise<boolean>;

const avatar = "grid size-10 shrink-0 place-items-center rounded-pill bg-green-tint text-small font-semibold text-sponsor-ink";
const rolePill = (role: string) => `inline-flex min-h-[30px] items-center rounded-pill px-3 text-small font-medium ${role === "account_owner" ? "bg-ink text-white" : "bg-lilac text-ink"}`;
const link = "inline-flex min-h-11 items-center px-2 font-semibold text-deep-green underline-offset-2 hover:underline disabled:opacity-50";

/** Role and signer switch: a viewer can never sign (VIEWER_NOT_SIGNER), so the switch is off and locked for one. */
function RoleFields({ role, signer, onRole, onSigner, idp }: { role: string; signer: boolean; onRole: (r: string) => void; onSigner: (s: boolean) => void; idp: string }) {
  return (
    <>
      <Select label="Role" id={`${idp}-role`} value={role} onChange={(e) => { onRole(e.target.value); if (e.target.value === "viewer") onSigner(false); }} help={ROLE_HELP[role]}>
        {INVITE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
      </Select>
      <Checkbox id={`${idp}-signer`} label="Can sign the sponsorship statement" checked={signer && role !== "viewer"} disabled={role === "viewer"} onChange={(e) => onSigner(e.target.checked)} />
    </>
  );
}

function MemberRow({ m, mine, isOwner, act, pending }: { m: Member; mine: boolean; isOwner: boolean; act?: Act; pending?: boolean }) {
  const [edit, setEdit] = useState(false), [role, setRole] = useState(m.role), [signer, setSigner] = useState(m.isSigner);
  const owner = m.role === "account_owner";
  return (
    <li data-member={m.membershipId} className="flex flex-col gap-3 border-t border-line px-4 py-3 first:border-0 sm:px-6">
      <div className="grid items-center gap-x-4 gap-y-2 md:grid-cols-[minmax(0,2fr)_8rem_6rem_8rem_13rem]">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className={avatar}>{initials(m.name || m.email)}</span>
          <span className="min-w-0"><span className="block truncate font-semibold">{m.name || m.email}{mine ? " (you)" : ""}</span><span className="block truncate text-small text-muted">{m.email}</span></span>
        </div>
        <span><span className={rolePill(m.role)}>{ROLE_LABEL[m.role] ?? m.role}</span></span>
        <span className="text-small md:text-ui"><span className="text-muted md:hidden">Can sign: </span>{m.isSigner ? "Yes" : "No"}</span>
        <span className="text-small text-muted md:text-ui md:text-ink"><span className="md:hidden">Last active: </span>{day(m.lastActiveAt) ?? "Not yet"}</span>
        <span className="flex flex-wrap md:justify-end">
          {isOwner && !owner && act && (
            <>
              <button type="button" className={link} aria-expanded={edit} onClick={() => setEdit(!edit)}>Change role</button>
              <button type="button" className={link} disabled={pending} onClick={() => void act({ action: "remove", membershipId: m.membershipId }, `${m.name || m.email} was removed.`)}>Remove</button>
            </>
          )}
        </span>
      </div>
      {edit && act && (
        <form className="flex flex-col gap-3 rounded-card bg-sand p-4 sm:max-w-md" onSubmit={async (e) => { e.preventDefault(); if (await act({ action: "role", membershipId: m.membershipId, role, isSigner: signer && role !== "viewer" }, `The role of ${m.name || m.email} was changed.`)) setEdit(false); }}>
          <RoleFields role={role} signer={signer} onRole={setRole} onSigner={setSigner} idp={`m${m.membershipId}`} />
          <Button type="submit" variant="dark" disabled={pending} className="self-start">Save role</Button>
        </form>
      )}
    </li>
  );
}

function InviteRow({ i, act, pending }: { i: Invite; act?: Act; pending?: boolean }) {
  return (
    <li data-invite={i.membershipId} className="grid items-center gap-x-4 gap-y-2 border-t border-line px-4 py-3 sm:px-6 md:grid-cols-[minmax(0,2fr)_8rem_6rem_8rem_13rem]">
      <div className="flex min-w-0 items-center gap-3">
        <span aria-hidden="true" className={avatar}><Icon name="mail" size={18} /></span>
        <span className="min-w-0"><span className="block truncate font-semibold">{i.email}</span><span className="block text-small text-muted">{ROLE_LABEL[i.role] ?? i.role} · invite sent {day(i.invitedAt) ?? "recently"}</span></span>
      </div>
      <span><span className="inline-flex min-h-[30px] items-center rounded-pill bg-peach px-3 text-small font-medium">Invited</span></span>
      <span className="text-small md:text-ui"><span className="text-muted md:hidden">Can sign: </span>{i.isSigner ? "Yes" : "No"}</span>
      <span className="text-small text-muted md:text-ui md:text-ink">Ends {day(i.expiresAt) ?? "soon"}</span>
      <span className="flex flex-wrap md:justify-end">
        {act && (
          <>
            <button type="button" className={link} disabled={pending} onClick={() => void act({ action: "resend", membershipId: i.membershipId }, `The invitation to ${i.email} was sent again.`)}>Resend</button>
            <button type="button" className={link} disabled={pending} onClick={() => void act({ action: "remove", membershipId: i.membershipId }, `The invitation to ${i.email} was cancelled.`)}>Cancel</button>
          </>
        )}
      </span>
    </li>
  );
}

function RequestRow({ r, act, pending }: { r: JoinRequest; act: Act; pending?: boolean }) {
  const [role, setRole] = useState<string>("viewer"), [signer, setSigner] = useState(false);
  return (
    <li data-request={r.membershipId} className="flex flex-col gap-3 border-t border-line py-4 first:border-0">
      <div className="flex min-w-0 items-center gap-3">
        <span aria-hidden="true" className={avatar}>{initials(r.name || r.email)}</span>
        <span className="min-w-0"><span className="block truncate font-semibold">{r.name || r.email}</span><span className="block truncate text-small text-muted">{r.email}</span></span>
      </div>
      <div className="flex flex-col gap-3 sm:max-w-md">
        <RoleFields role={role} signer={signer} onRole={setRole} onSigner={setSigner} idp={`r${r.membershipId}`} />
        <div className="flex flex-wrap gap-3">
          <Button variant="dark" disabled={pending} onClick={() => void act({ action: "approve", membershipId: r.membershipId, role, isSigner: signer && role !== "viewer" }, `${r.name || r.email} joined the team.`)}>Approve</Button>
          <Button variant="outline" disabled={pending} onClick={() => void act({ action: "refuse", membershipId: r.membershipId }, "The request was refused.")}>Refuse</Button>
        </div>
      </div>
    </li>
  );
}

function InviteForm({ act, pending, full }: { act: Act; pending?: boolean; full: boolean }) {
  const [role, setRole] = useState<string>("poster"), [signer, setSigner] = useState(false), [email, setEmail] = useState("");
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (await act({ action: "invite", email: email.trim(), role, isSigner: signer && role !== "viewer" }, `We sent an invitation to ${email.trim()}.`)) { setEmail(""); setSigner(false); }
  }
  return (
    <form id="invite" onSubmit={onSubmit} className="flex flex-col gap-5 rounded-bento bg-sand p-6 sm:p-8" aria-busy={pending || undefined}>
      <h2 className="text-[22px]">Invite a teammate</h2>
      {full && <Notice kind="warning" title="The team is full">Remove a member or cancel an invitation to make room.</Notice>}
      <Input label="Work email" name="email" type="email" icon="mail" required maxLength={254} autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
      <RoleFields role={role} signer={signer} onRole={setRole} onSigner={setSigner} idp="invite" />
      <Button type="submit" variant="dark" size="lg" disabled={pending || full} className="self-start">{pending ? "Sending" : "Send invite"}</Button>
    </form>
  );
}

function Transfer({ members, act, pending }: { members: Member[]; act: Act; pending?: boolean }) {
  const others = members.filter((m) => m.role !== "account_owner");
  const [to, setTo] = useState(others[0]?.membershipId ?? ""), [sure, setSure] = useState(false);
  const who = others.find((m) => m.membershipId === to);
  return (
    <section aria-labelledby="transfer-h" className="flex flex-col gap-4 rounded-bento bg-sand p-6 sm:p-8">
      <h2 id="transfer-h" className="text-[22px]">Transfer ownership</h2>
      <p className="text-muted">The owner manages the team and gets strike and appeal notices, as does the person who posted the job. Transfer it if you leave the company. You become a recruiter.</p>
      {others.length === 0 ? <p className="text-small text-muted">Invite a teammate first: ownership goes to a member of the team.</p> : (
        <>
          <Select label="New owner" value={to} onChange={(e) => { setTo(e.target.value); setSure(false); }}>
            {others.map((m) => <option key={m.membershipId} value={m.membershipId}>{m.name || m.email}</option>)}
          </Select>
          {sure
            ? <div className="flex flex-wrap items-center gap-3"><Button variant="danger" disabled={pending} onClick={() => void act({ action: "transfer", membershipId: to }, `${who?.name || who?.email} is the account owner now.`)}>Yes, make {who?.name || who?.email} the owner</Button><Button variant="chip" onClick={() => setSure(false)}>Not now</Button></div>
            : <Button variant="chip" onClick={() => setSure(true)} className="self-start">Transfer ownership</Button>}
        </>
      )}
    </section>
  );
}

export function TeamView({ team, myId, isOwner, limit, act, error, note, pending }: { team: Team; myId: string; isOwner: boolean; limit: number; act?: Act; error?: string; note?: string; pending?: boolean }) {
  const used = team.members.length + team.invites.length + team.requests.length;
  const full = used >= limit;
  const a = isOwner ? act : undefined;
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1>Team</h1>
          <p className="mt-1 text-muted">Several people can post jobs. One owner invites and removes others.</p>
          <p className="mt-1 text-small text-muted" data-places>{used} of {limit} places used: people, open invitations and join requests.</p>
        </div>
        {isOwner && <Button href="#invite" variant="dark" size="lg"><Icon name="plus" size={18} />Invite a teammate</Button>}
      </header>
      <div aria-live="polite" className="flex flex-col gap-3 empty:hidden">
        {error && <Notice kind="error">{error}</Notice>}
        {note && !error && <Notice kind="success">{note}</Notice>}
      </div>
      <section aria-label="People" className="overflow-hidden rounded-card border border-line">
        <div aria-hidden="true" className="hidden border-b border-line px-6 py-3 text-small font-semibold md:grid md:grid-cols-[minmax(0,2fr)_8rem_6rem_8rem_13rem] md:gap-x-4"><span>Person</span><span>Role</span><span>Can sign</span><span>Last active</span><span /></div>
        <ul className="bg-sand">
          {team.members.map((m) => <MemberRow key={m.membershipId} m={m} mine={m.membershipId === myId} isOwner={isOwner} act={a} pending={pending} />)}
          {team.invites.map((i) => <InviteRow key={i.membershipId} i={i} act={a} pending={pending} />)}
        </ul>
      </section>
      {isOwner && team.requests.length > 0 && (
        <section aria-labelledby="requests-h" className="rounded-bento bg-sand p-6 sm:p-8">
          <h2 id="requests-h" className="text-[22px]">Join requests</h2>
          <p className="mt-1 text-muted">These people asked to join with an email address on your company&apos;s domain. Choose a role to approve.</p>
          <ul>{team.requests.map((r) => <RequestRow key={r.membershipId} r={r} act={act!} pending={pending} />)}</ul>
        </section>
      )}
      {isOwner && act && (
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <InviteForm act={act} pending={pending} full={full} />
          <Transfer members={team.members} act={act} pending={pending} />
        </div>
      )}
    </div>
  );
}

export function TeamBoard(props: { team: Team; myId: string; isOwner: boolean; limit: number }) {
  const router = useRouter();
  const [error, setError] = useState<string>(), [note, setNote] = useState<string>(), [pending, setPending] = useState(false);
  const act: Act = async (body, done) => {
    setPending(true); setError(undefined); setNote(undefined);
    const a = await send("/api/portal/team", "POST", body);
    if (needsReauth(a)) { setError(say(a)); await reauth("/team"); return false; }
    setPending(false);
    if (a.status === 200) { setNote(done); router.refresh(); return true; }
    setError(say(a));
    return false;
  };
  return <TeamView {...props} act={act} error={error} note={note} pending={pending} />;
}
