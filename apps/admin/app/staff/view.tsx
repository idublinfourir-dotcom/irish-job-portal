// Staff and roles (frame D14) as parts that take their data as props, so a test renders every state. The team table with each person's roles and status, the role grants waiting for a
// second administrator (who proposed each, and the same person cannot confirm), the permission matrix, and the invite. No two-step or last-active column (CF111, Q86); "Super admin" is the
// administrator role (CF103, Q75). The last active administrator cannot lose the role or be disabled (the buttons say so, and the route refuses it too).
import type { StaffRow } from "@portal/db";
import { Notice, Pill } from "@portal/ui";
import { ageText } from "../_queue/age";
import { PostButton } from "../_queue/post-button";
import { InviteForm, RoleForm } from "./actions";
import { matrixRows, ROLES, roleLabel } from "./matrix";

export type Pending = { requestId: string; staffId: string; role: string; proposedBy: string; createdAt: string };
const BACK = "/staff";

/** How many active logins hold the administrator role. */
export const activeAdmins = (staff: StaffRow[]): number => staff.filter((s) => s.status === "active" && s.roles.includes("administrator")).length;

export function PendingGrants({ pending, staff, meId, now }: { pending: Pending[]; staff: StaffRow[]; meId: string; now: Date }) {
  if (pending.length === 0) return <p className="text-small text-muted">No role grant is waiting.</p>;
  const name = (id: string) => staff.find((s) => s.id === id)?.name ?? "Unknown person";
  return (
    <ul className="flex flex-col gap-3">
      {pending.map((g) => {
        const mine = g.proposedBy === meId;
        return (
          <li key={g.requestId} className="flex flex-col gap-2 rounded-card bg-white p-4">
            <p className="[overflow-wrap:anywhere]"><span className="font-semibold">{name(g.staffId)}</span> as <span className="font-semibold">{roleLabel(g.role)}</span></p>
            <p className="text-small text-muted">Proposed by {mine ? "you" : name(g.proposedBy)} · {ageText(g.createdAt, now)} ago</p>
            {mine ? <p className="text-small">A different administrator confirms it. You can withdraw it.</p> : null}
            <div className="flex flex-wrap gap-2">
              {!mine && <PostButton url="/api/staff" body={{ action: "confirm_role", requestId: g.requestId }} label="Confirm" back={BACK} confirm={{ title: "Confirm this role?", text: `${name(g.staffId)} gets the ${roleLabel(g.role)} role at once.`, button: "Confirm" }} />}
              <PostButton url="/api/staff" body={{ action: "refuse_role", requestId: g.requestId }} label={mine ? "Withdraw" : "Refuse"} variant="chip" back={BACK} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function Team({ staff, pending, meId }: { staff: StaffRow[]; pending: Pending[]; meId: string }) {
  const admins = activeAdmins(staff);
  return (
    <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-card border border-line bg-white">
      {staff.map((s) => {
        const active = s.status === "active";
        const lastAdmin = active && s.roles.includes("administrator") && admins <= 1;
        const invited = active && s.roles.length === 0 && pending.some((g) => g.staffId === s.id);
        return (
          <li key={s.id} className="flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold [overflow-wrap:anywhere]">{s.name}{s.id === meId ? " (you)" : ""}</p>
                <p className="text-small text-muted [overflow-wrap:anywhere]">{s.email}</p>
              </div>
              <Pill tone={active ? "green" : "peach"} className="min-h-[30px]">{active ? "Active" : "Disabled"}</Pill>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {s.roles.length === 0 && <span className="text-small text-muted">No role yet</span>}
              {s.roles.map((r) => (
                <span key={r} className="inline-flex items-center gap-1">
                  {r === "administrator" ? <span className="inline-flex min-h-[30px] items-center rounded-pill bg-ink px-3.5 text-small font-medium text-white">{roleLabel(r)}</span> : <Pill tone="lilac" className="min-h-[30px]">{roleLabel(r)}</Pill>}
                  <PostButton url="/api/staff" body={{ action: "remove_role", staffId: s.id, role: r }} label="Remove" what={roleLabel(r)} variant="chip" back={BACK} disabled={r === "administrator" && lastAdmin}
                    confirm={{ title: "Remove this role?", text: `${s.name} loses the ${roleLabel(r)} role at once.`, button: "Remove" }} />
                </span>
              ))}
            </div>
            {lastAdmin && <p className="text-small text-muted">The last active administrator cannot lose the role or be disabled. Make another administrator first.</p>}
            <div className="flex flex-wrap items-end gap-3">
              {active && <RoleForm staffId={s.id} name={s.name} held={s.roles} />}
              {invited && <PostButton url="/api/staff" body={{ action: "resend_invite", staffId: s.id }} label="Resend invite" variant="chip" back={BACK} />}
              {active && <PostButton url="/api/staff" body={{ action: "disable", staffId: s.id }} label="Disable" variant="danger" back={BACK} disabled={lastAdmin}
                confirm={{ title: "Disable this login?", text: `${s.name} is signed out at once and cannot sign in until the login is turned back on.`, button: "Disable" }} />}
              {!active && s.roles.length === 0 && <PostButton url="/api/staff" body={{ action: "enable", staffId: s.id }} label="Enable" variant="chip" back={BACK} />}
              {!active && s.roles.length > 0 && <p className="text-small text-muted">Remove its roles before turning it back on.</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function Matrix() {
  return (
    <div className="relative overflow-x-auto rounded-card border border-line bg-white">
      <table className="w-full min-w-[34rem] text-left text-small">
        <caption className="sr-only">Who sees each area</caption>
        <thead>
          <tr className="border-b border-line"><th scope="col" className="px-3 py-3 font-semibold">Area</th>{ROLES.map((r) => <th key={r} scope="col" className="px-2 py-3 text-center font-semibold">{roleLabel(r)}</th>)}</tr>
        </thead>
        <tbody>
          {matrixRows().map((m) => (
            <tr key={m.area} className="border-b border-line odd:bg-sand/60 last:border-b-0">
              <th scope="row" className="px-3 py-2.5 font-normal">{m.area}</th>
              {ROLES.map((r) => <td key={r} className="px-2 py-2.5 text-center">{m.allowed.includes(r) ? <span className="font-semibold text-deep-green">Yes<span className="sr-only"> for {roleLabel(r)}</span></span> : <span className="text-muted">No<span className="sr-only"> for {roleLabel(r)}</span></span>}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Staff({ staff, truncated, pending, meId, now }: { staff: StaffRow[]; truncated: boolean; pending: Pending[]; meId: string; now: Date }) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 text-[32px] leading-tight md:text-[34px]">Staff and roles</h1>
          <p className="text-muted">One small team runs admin and services, with separate permissions per role. A second administrator confirms every role grant.</p>
        </div>
        <InviteForm />
      </header>
      {truncated && <Notice kind="warning">There are more than 200 logins. Only the first 200 are shown.</Notice>}
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <section aria-label="Team" className="flex flex-col gap-3"><h2 className="text-[22px]">Team</h2><Team staff={staff} pending={pending} meId={meId} /></section>
          <section aria-label="Waiting for a second administrator" className="flex flex-col gap-3 rounded-bento bg-lilac-soft p-5">
            <h2 className="text-[22px]">Waiting for a second administrator</h2>
            <PendingGrants pending={pending} staff={staff} meId={meId} now={now} />
          </section>
        </div>
        <section aria-label="Permission matrix" className="flex min-w-0 flex-col gap-3 rounded-bento bg-sand p-5">
          <h2 className="text-[22px]">Permission matrix</h2>
          <Matrix />
          <p className="text-small text-muted">An administrator manages staff and roles, the audit log and the rules data. It does not stand in for the other six roles: each queue is for its own role only.</p>
        </section>
      </div>
    </div>
  );
}
