// The guard order and the pure checks of the staff, audit and content modules (step 13d), with a fake database. No network, no real database.
import { describe, expect, it } from "vitest";
import { QueueRefused } from "./admin-queue";
import { listAudit } from "./audit-read";
import { checkSlug, createContentDraft, editContentDraft, getContentPage, listContentPages, PUBLISHER, publishContent, withdrawContent } from "./content-admin";
import { confirmRoleGrant, disableLogin, enableLogin, listStaff, proposeRoleGrant, refuseRoleGrant, removeRole, staffRoles, STAFF_ROLE_LIST } from "./staff-admin";
import { STAFF_ROLES } from "./staff-seed-cli";

type Answer = { rows?: unknown[]; rowCount?: number; error?: object };
// A database that records what it was asked and answers from a queue (transaction words are not counted).
function fake(answers: Answer[] = []) {
  const calls: string[] = [];
  const query = async (sql: string) => {
    if (/^(begin|commit|rollback)/.test(sql)) return { rows: [], rowCount: 0 };
    calls.push(sql);
    const a = answers.shift() ?? {};
    if (a.error) throw Object.assign(new Error("fake database error"), a.error);
    return { rows: a.rows ?? [], rowCount: a.rowCount ?? a.rows?.length ?? 0 };
  };
  return { db: { query, connect: async () => ({ query, release: () => {} }) } as never, calls };
}
const who = (roles: string[], active = true): Answer => ({ rows: [{ active, roles }] });
const why = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e instanceof QueueRefused ? e.why : `other: ${(e as Error).message}`; } return "ok"; };

describe("the role list", () => {
  it("is the owner's command's list", () => expect([...STAFF_ROLE_LIST]).toEqual(STAFF_ROLES));
});

describe("staffRoles", () => {
  it("refuses an unknown, disabled or malformed login, and returns the roles of an active one", async () => {
    expect(await why(staffRoles(fake([{ rows: [] }]).db, "x"))).toBe("not_active_staff");
    expect(await why(staffRoles(fake([who(["administrator"], false)]).db, "x"))).toBe("not_active_staff");
    for (const bad of ["", "a b", "a".repeat(65), "a;b", 5 as never, null as never]) {
      const { db, calls } = fake();
      expect(await why(staffRoles(db, bad)), String(bad)).toBe("not_active_staff");
      expect(calls).toEqual([]);
    }
    expect(await staffRoles(fake([who(["content_editor", "administrator"])]).db, "x")).toEqual(["content_editor", "administrator"]);
  });
});

describe("staff routes' database calls: who may, and input before the database", () => {
  const notAdmin = () => fake([who(["content_editor"])]);
  it("every call refuses a login that is not an administrator, after the role check and before anything else", async () => {
    const calls: [string, (db: never) => Promise<unknown>][] = [
      ["list", (db) => listStaff(db, "s")], ["propose", (db) => proposeRoleGrant(db, "s", "t", "content_editor")], ["confirm", (db) => confirmRoleGrant(db, "s", "1")],
      ["refuse", (db) => refuseRoleGrant(db, "s", "1")], ["remove", (db) => removeRole(db, "s", "t", "content_editor")], ["disable", (db) => disableLogin(db, "s", "t")],
      ["enable", (db) => enableLogin(db, "s", "t")],
    ];
    for (const [name, run] of calls) {
      const { db, calls: sql } = notAdmin();
      expect(await why(run(db)), name).toBe("not_administrator");
      expect(sql.length, name).toBe(1); // the role check only
    }
  });
  it("refuses bad ids and roles without a query", async () => {
    for (const run of [
      (db: never) => proposeRoleGrant(db, "s", "bad id", "content_editor"), (db: never) => proposeRoleGrant(db, "s", "t", "boss"), (db: never) => removeRole(db, "s", "t;", "administrator"),
      (db: never) => removeRole(db, "s", "t", "Administrator"), (db: never) => disableLogin(db, "s", ""), (db: never) => enableLogin(db, "s", "a".repeat(65)),
    ]) {
      const { db, calls } = fake([who(["administrator"])]);
      expect(await why(run(db as never))).toMatch(/^bad_(staff_id|role)$/);
      expect(calls).toEqual([]);
    }
  });
  it("keeps one administrator: refuses when the login leaving is the only active one, lets it through when another remains", async () => {
    const lock = { rows: [] as unknown[] };
    const only = fake([who(["administrator"]), lock, { rows: [{ id: "t" }] }]);
    expect(await why(disableLogin(only.db, "s", "t"))).toBe("last_administrator");
    expect(only.calls.length).toBe(3); // role check, lock, count: nothing was written
    const two = fake([who(["administrator"]), lock, { rows: [{ id: "t" }, { id: "u" }] }, { rowCount: 1 }, { rowCount: 2 }, {}]);
    expect(await disableLogin(two.db, "s", "t")).toEqual({ sessionsEnded: 2 });
    const notAdminTarget = fake([who(["administrator"]), lock, { rows: [{ id: "u" }] }, { rowCount: 1 }, { rowCount: 0 }, {}]);
    expect(await disableLogin(notAdminTarget.db, "s", "t")).toEqual({ sessionsEnded: 0 });
    const rm = fake([who(["administrator"]), lock, { rows: [{ id: "t" }] }]);
    expect(await why(removeRole(rm.db, "s", "t", "administrator"))).toBe("last_administrator");
    const rmOther = fake([who(["administrator"]), { rowCount: 1 }, {}]);
    await removeRole(rmOther.db, "s", "t", "content_editor"); // a role that is not administrator takes no lock
    expect(rmOther.calls.some((c) => c.includes("for update"))).toBe(false);
  });
  it("enable refuses a login that is not disabled or still holds a role, and says so before writing", async () => {
    expect(await why(enableLogin(fake([who(["administrator"]), { rows: [{ status: "active", roles: 0 }] }]).db, "s", "t"))).toBe("not_disabled");
    expect(await why(enableLogin(fake([who(["administrator"]), { rows: [{ status: "disabled", roles: 2 }] }]).db, "s", "t"))).toBe("holds_roles");
    expect(await why(enableLogin(fake([who(["administrator"]), { rows: [] }]).db, "s", "t"))).toBe("not_found");
  });
  it("the proposer of a grant cannot confirm it", async () => {
    const f = fake([who(["administrator"]), { rows: [{ id: "5", status: "pending", kind: "grant_role", target_id: "t", role: "content_editor", proposed_by: "s" }] }]);
    expect(await why(confirmRoleGrant(f.db, "s", "5"))).toBe("same_person");
    expect(await why(confirmRoleGrant(fake([who(["administrator"]), { rows: [{ id: "5", status: "confirmed", kind: "grant_role", target_id: "t", role: "x", proposed_by: "u" }] }]).db, "s", "5"))).toBe("request_not_pending");
  });
});

describe("audit-read, before the database", () => {
  it("checks every filter before any query", async () => {
    const bad = [{ staff: "a b" }, { action: "Bad" }, { objectType: "a.b" }, { objectId: "a b" }, { from: "2026-02-30" }, { to: "26-1-1" }, { from: "2026-03-02", to: "2026-03-01" }, { after: "x" }];
    for (const f of bad) {
      const { db, calls } = fake();
      expect(await why(listAudit(db, "s", f)), JSON.stringify(f)).toMatch(/^bad_/);
      expect(calls).toEqual([]);
    }
  });
  it("holds anyone but an administrator to their own rows, and passes an administrator's filter through", async () => {
    const own = fake([who(["content_editor"]), { rows: [] }]);
    await listAudit(own.db, "me", {});
    expect(own.calls.length).toBe(2);
    const other = fake([who(["content_editor"])]);
    expect(await why(listAudit(other.db, "me", { staff: "someone" }))).toBe("not_administrator");
    expect(other.calls.length).toBe(1);
    expect(await why(listAudit(fake([who([])]).db, "me", { staff: "me" }))).toBe("ok"); // a login with no role may read its own (none) rows
  });
  it("pages 50 and gives a cursor only when there is another page", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({ id: String(100 - i), at_text: "2026-03-10 12:00:00+00", kind: "admin_action", action: "x" }));
    const r = await listAudit(fake([who(["administrator"]), { rows }]).db, "me", {});
    expect(r.events.length).toBe(50);
    expect(r.next).toMatch(/^[A-Za-z0-9_-]+$/);
    expect((await listAudit(fake([who(["administrator"]), { rows: rows.slice(0, 50) }]).db, "me", {})).next).toBeNull();
  });
});

describe("content-admin, before the database", () => {
  const draft = { kind: "help", slug: "a-page", title: "T", body: "B" };
  it("the slug rules: words with hyphens, four digits for an occupation", () => {
    for (const [k, s] of [["help", "a-page"], ["guide", "a1-b2"], ["occupation", "2134"]] as const) expect(checkSlug(k, s)).toBe(s);
    for (const [k, s] of [["help", "A"], ["help", ""], ["help", "a b"], ["occupation", "213"], ["occupation", "abcd"], ["occupation", "21345"], ["help", 5]] as const) expect(() => checkSlug(k, s), String(s)).toThrow(QueueRefused);
  });
  it("names who publishes what", () => expect(PUBLISHER).toEqual({ help: "content_editor", update: "content_editor", guide: "rules_data_editor", occupation: "rules_data_editor" }));
  it("refuses bad input without a query", async () => {
    for (const d of [{ ...draft, kind: "x" }, { ...draft, slug: "A" }, { ...draft, title: "" }, { ...draft, body: "a\u0000" }, { ...draft, sourceUrl: "javascript:1" }, { ...draft, checkedOn: "2099-01-01" }, { ...draft, checkedOn: "2026-13-01" }]) {
      const { db, calls } = fake();
      expect(await why(createContentDraft(db, "s", d)), JSON.stringify(d)).toMatch(/^bad_/);
      expect(calls).toEqual([]);
    }
    for (const id of ["0", "x", "1;2", ""]) expect(await why(publishContent(fake().db, "s", id))).toBe("not_found");
    expect(await why(editContentDraft(fake().db, "s", "1", {}))).toBe("nothing_to_change");
  });
  it("the role gates: drafts and withdrawals for a content editor only, reads for the three content roles, publishing by kind", async () => {
    expect(await why(createContentDraft(fake([who(["rules_data_editor", "administrator"])]).db, "s", draft))).toBe("not_content_editor");
    expect(await why(editContentDraft(fake([who(["administrator"])]).db, "s", "1", { title: "x" }))).toBe("not_content_editor");
    expect(await why(withdrawContent(fake([who(["rules_data_editor"])]).db, "s", "1"))).toBe("not_content_editor");
    expect(await why(listContentPages(fake([who(["trust_and_safety"])]).db, "s"))).toBe("not_content_staff");
    expect(await why(getContentPage(fake([who(["account_reviewer"])]).db, "s", "1"))).toBe("not_content_staff");
    expect(await why(publishContent(fake([who(["administrator"])]).db, "s", "1"))).toBe("not_publisher");
    const page = (kind: string, status = "draft") => ({ rows: [{ kind, status }] });
    expect(await why(publishContent(fake([who(["content_editor"]), page("guide")]).db, "s", "1"))).toBe("not_rules_data_editor");
    expect(await why(publishContent(fake([who(["rules_data_editor"]), page("update")]).db, "s", "1"))).toBe("not_content_editor");
    expect(await why(publishContent(fake([who(["content_editor"]), page("help", "published")]).db, "s", "1"))).toBe("already_published");
    expect(await why(publishContent(fake([who(["content_editor"]), page("help"), {}, {}]).db, "s", "1"))).toBe("ok");
  });
  it("turns the database's refusals into codes and lets anything else through", async () => {
    const page = { rows: [{ kind: "guide", status: "draft" }] };
    expect(await why(publishContent(fake([who(["rules_data_editor"]), page, { error: { code: "23514" } }]).db, "s", "1"))).toBe("needs_source_and_checked_on");
    expect(await why(publishContent(fake([who(["rules_data_editor"]), page, { error: { code: "57P01" } }]).db, "s", "1"))).toBe("other: fake database error");
    expect(await why(createContentDraft(fake([who(["content_editor"]), { error: { code: "23505" } }]).db, "s", draft))).toBe("slug_taken");
  });
});
