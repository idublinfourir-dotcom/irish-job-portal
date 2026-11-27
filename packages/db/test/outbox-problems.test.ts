// OPS-5: the staff digest's stuck and failed email counts, on the real test database as app_admin. Fake people only.
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./db";
import { digestLines } from "../src/outbox-cli.ts";
import { OUTBOX_PROBLEMS, outboxProblems, writeDigest } from "../src/staff-digest-cli.ts";

let db: TestDb, su: pg.Pool, admin: pg.Pool;
beforeAll(async () => { db = await createTestDb(); su = db.pool("postgres"); admin = db.pool("app_admin"); });
afterAll(() => db.drop());
let n = 0;
const row = (status: string, hoursAgo: number, template = "t") =>
  su.query("insert into email_outbox(template, candidate_user_id, status, dedupe_key, send_after, sent_at) values ($1, 'nobody', $2, $3, now() - $4 * interval '1 hour', null)", [template, status, `p${++n}`, hoursAgo]);

describe("outbox problems in the digest", () => {
  it("counts a row left sending for over an hour and a failed row of the last 7 days, and nothing else", async () => {
    await su.query("delete from email_outbox");
    await row("sending", 2); await row("sending", 3); await row("sending", 0.1); // 2 stuck, 1 in flight
    await row("failed", 24); await row("failed", 24 * 8); // 1 recent, 1 old
    await row("pending", 5); await row("sent", 2); await row("dropped", 2);
    expect(outboxProblems((await admin.query(OUTBOX_PROBLEMS)).rows[0])).toEqual({ emailsStuck: 2, emailsFailed: 1 });
  });
  it("only administrators get the lines, with fixed labels and no address", async () => {
    const [ad, ts] = [await F("a"), await F("t")];
    await su.query("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1,'administrator',true), ($2,'trust_and_safety',true)", [ad, ts]);
    await writeDigest(admin);
    const p = async (s: string) => (await su.query("select params from email_outbox where template = 'staff_digest' and staff_user_id = $1", [s])).rows[0]?.params;
    expect(await p(ad)).toMatchObject({ emailsStuck: 2, emailsFailed: 1 });
    expect(await p(ts)).toBeUndefined();
    expect(digestLines(await p(ad))).toEqual(expect.arrayContaining(["Emails stuck sending for over an hour: 2", "Emails given up on in the last 7 days: 1"]));
    expect(JSON.stringify(await p(ad))).not.toContain("@");
  });
  it("is quiet when nothing is stuck or failed (zero shows no line)", async () => {
    expect(digestLines({ emailsStuck: 0, emailsFailed: 0 })).toEqual([]);
    expect(outboxProblems({ stuck: "x", failed: -1.5 })).toEqual({ emailsStuck: 0, emailsFailed: 0 });
  });
});
const F = async (p: string) => { const i = `${p}-${++n}`; await su.query("insert into staff_user(id,name,email,email_verified,created_at,updated_at) values ($1,'Fake','x'||$1||'@example.test',true,now(),now())", [i]); return i; };
