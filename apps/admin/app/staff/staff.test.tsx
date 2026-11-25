// The staff and roles page (frame D14): the team, the grants waiting for a second administrator, the matrix, the invite and the last-administrator guard. react-dom/server, no browser,
// no network.
import type { StaffRow } from "@portal/db";
import { ADMIN_NAV, ADMIN_ROLES } from "@portal/ui";
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InviteView, RoleFormView } from "./actions";
import { matrixRows, roleLabel } from "./matrix";
import { activeAdmins, Matrix, type Pending, Staff } from "./view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }), usePathname: () => "/staff" }));

const NOW = new Date("2026-11-25T12:00:00Z");
const person = (id: string, o: Partial<StaffRow> = {}): StaffRow => ({ id, name: `Fake ${id}`, email: `${id}@example.test`, status: "active", createdAt: "2026-11-01 09:00:00+00", roles: ["account_reviewer"], ...o });
const grant = (o: Partial<Pending> = {}): Pending => ({ requestId: "9", staffId: "bob", role: "content_editor", proposedBy: "me", createdAt: "2026-11-25 10:00:00+00", ...o });
const page = (o: { staff?: StaffRow[]; pending?: Pending[]; me?: string; truncated?: boolean } = {}) =>
  html(<Staff staff={o.staff ?? [person("me", { roles: ["administrator"] }), person("bob")]} truncated={o.truncated ?? false} pending={o.pending ?? []} meId={o.me ?? "me"} now={NOW} />);
const clean = (t: string) => expect(t).not.toMatch(/[\u2013\u2014]|undefined|\[object|Launch B|Sample|Two-step|Last active|Super admin/);

describe("the team", () => {
  it("shows each person with name, email, roles and state; no two-step or last-active column; 'Super admin' is the Administrator", () => {
    const p = page();
    expect(p).toMatch(/Fake me \(you\)/);
    expect(p).toMatch(/bob@example\.test/);
    expect(p).toMatch(/Account reviewer/);
    expect(p).toMatch(/>Administrator</);
    expect(p).toMatch(/>Active</);
    expect(p).toMatch(/>Invite staff</);
    clean(p);
  });
  it("the only active administrator has Disable and Remove administrator switched off, with the reason", () => {
    const p = page();
    expect(p).toMatch(/<button[^>]*disabled[^>]*>Remove Administrator/);
    expect(p).toMatch(/<button[^>]*disabled[^>]*>Disable/);
    expect(p).toMatch(/last active administrator cannot lose the role or be disabled/);
    expect(p).not.toMatch(/<button[^>]*disabled[^>]*>Remove Account reviewer/);
  });
  it("with two administrators neither is guarded; a disabled administrator does not count", () => {
    const two = [person("me", { roles: ["administrator"] }), person("ann", { roles: ["administrator"] })];
    expect(activeAdmins(two)).toBe(2);
    expect(page({ staff: two })).not.toMatch(/last active administrator/);
    const one = [person("me", { roles: ["administrator"] }), person("ann", { roles: ["administrator"], status: "disabled" })];
    expect(activeAdmins(one)).toBe(1);
    expect(page({ staff: one })).toMatch(/last active administrator/);
  });
  it("a disabled login with no role can be enabled; one that holds roles must lose them first; a disabled login cannot be given a role", () => {
    const p = page({ staff: [person("me", { roles: ["administrator"] }), person("gone", { status: "disabled", roles: [] }), person("held", { status: "disabled", roles: ["content_editor"] })] });
    expect(p).toMatch(/>Enable</);
    expect(p).toMatch(/Remove its roles before turning it back on/);
    expect(p.match(/Propose a role for/g)!.length).toBe(1); // only the active person
    expect(p).toMatch(/>Disabled</);
  });
  it("a person invited and waiting for a grant can be sent the invite again; no one else", () => {
    const p = page({ staff: [person("me", { roles: ["administrator"] }), person("new", { roles: [] })], pending: [grant({ staffId: "new" })] });
    expect(p).toMatch(/>Resend invite</);
    expect(page()).not.toMatch(/Resend invite/);
  });
  it("names and emails are text, never markup; a long list says it is cut", () => {
    const p = page({ staff: [person("me", { roles: ["administrator"], name: "<script>x</script>" })], truncated: true });
    expect(p).not.toMatch(/<script>/);
    expect(p).toMatch(/more than 200 logins/);
  });
});

describe("the grants waiting for a second administrator", () => {
  it("one you proposed can only be withdrawn, and says a different administrator confirms; one another proposed can be confirmed or refused", () => {
    const mine = page({ pending: [grant()] });
    expect(mine).toMatch(/Proposed by you/);
    expect(mine).toMatch(/A different administrator confirms it/);
    expect(mine).toMatch(/>Withdraw</);
    expect(mine).not.toMatch(/>Confirm</);
    const theirs = page({ staff: [person("me", { roles: ["administrator"] }), person("bob"), person("ann", { roles: ["administrator"] })], pending: [grant({ proposedBy: "ann" })] });
    expect(theirs).toMatch(/Proposed by Fake ann/);
    expect(theirs).toMatch(/>Confirm</);
    expect(theirs).toMatch(/>Refuse</);
    expect(theirs).not.toMatch(/>Withdraw</);
    expect(theirs).toMatch(/Content editor/);
  });
  it("none waiting is a sentence; an unknown person is named as such", () => {
    expect(page()).toMatch(/No role grant is waiting/);
    expect(page({ pending: [grant({ staffId: "ghost" })] })).toMatch(/Unknown person/);
  });
});

describe("the permission matrix", () => {
  it("is read from the sidebar's own links: every area, every role, and the same answer as the links", () => {
    const rows = matrixRows();
    const links = ADMIN_NAV.flatMap((g) => g.links).filter((l) => l.href !== "/");
    expect(rows.map((r) => r.area)).toEqual(links.map((l) => l.label));
    for (const [i, l] of links.entries()) expect(rows[i]!.allowed).toEqual(l.roles ? ADMIN_ROLES.filter((r) => l.roles!.includes(r)) : [...ADMIN_ROLES]);
    const staff = rows.find((r) => r.area === "Staff and roles")!;
    expect(staff.allowed).toEqual(["administrator"]); // no other role stands in
    expect(rows.find((r) => r.area === "Account reviews")!.allowed).toEqual(["account_reviewer"]); // the administrator does not
    expect(rows.find((r) => r.area === "Audit log")!.allowed.length).toBe(7);
  });
  it("renders a column per role and a Yes or No for each cell", () => {
    const m = html(<Matrix />);
    for (const r of ADMIN_ROLES) expect(m).toContain(`>${roleLabel(r)}</th>`);
    expect(m).toMatch(/Yes<span class="sr-only"> for Administrator/);
    expect(m).toMatch(/No<span class="sr-only"> for Content editor/);
    expect(page()).not.toMatch(/Proposed . to confirm|Proposed to confirm/);
  });
});

describe("the invite and the role form", () => {
  const I = (o: Partial<Parameters<typeof InviteView>[0]> = {}) => html(<InviteView open pending={false} failed={null} sent={false} onOpen={() => {}} onClose={() => {}} onSubmit={() => {}} {...o} />);
  it("the invite form asks for name, email and one of the seven roles", () => {
    const f = I();
    for (const w of [/name="name"/, /name="email"/, /name="role"/, /Send the invitation/]) expect(f).toMatch(w);
    for (const r of ADMIN_ROLES) expect(f).toContain(`value="${r}"`);
  });
  it("sent, pending and each refusal show in words; the fresh sign-in comes with its link", () => {
    expect(I({ sent: true })).toMatch(/a different administrator confirms it/);
    expect(I({ pending: true })).toMatch(/disabled[^>]*>Sending|Sending/);
    expect(I({ failed: { code: "email_taken", status: 409 } })).toMatch(/already exists/);
    expect(I({ failed: { code: "email_not_sent", status: 502 } })).toMatch(/Resend invite on its row/);
    expect(I({ failed: { code: "reauth_required", status: 403 } })).toMatch(/href="\/sign-in\?again=1&amp;next=%2Fstaff"/);
    expect(I({ failed: { code: "bad_email", status: 400 } })).toMatch(/plain email address/);
  });
  it("the role form offers only roles the person lacks, none when they hold all", () => {
    const f = html(<RoleFormView held={["administrator", "content_editor"]} name="Fake Bob" pending={false} failed={null} onSubmit={() => {}} />);
    expect(f).not.toContain('value="administrator"');
    expect(f).not.toContain('value="content_editor"');
    expect(f).toContain('value="account_reviewer"');
    expect(html(<RoleFormView held={[...ADMIN_ROLES]} name="X" pending={false} failed={null} onSubmit={() => {}} />)).toMatch(/Holds every role/);
    expect(html(<RoleFormView held={[]} name="X" pending={false} failed={{ code: "grant_pending", status: 409 }} onSubmit={() => {}} />)).toMatch(/already waits for a second administrator/);
  });
});
