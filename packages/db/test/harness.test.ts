import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, race, rule, tx, type TestDb } from "./db";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  await db.query("postgres", "create table harness_probe (id int primary key)");
});
afterAll(() => db.drop());

test("race: five inserts of one key at once, one wins and the rest are refused as duplicates", async () => {
  const r = await race(5, () => db.query("postgres", "insert into harness_probe values (1)"));
  expect(r.ok).toHaveLength(1);
  expect(r.errors).toHaveLength(4);
  expect(r.errors[0]).toContain("23505");
});

test("tx: a throw rolls everything back", async () => {
  await tx(db.pool("postgres"), async (c) => {
    await c.query("insert into harness_probe values (2)");
    throw new Error("stop");
  }).catch(() => {});
  expect((await db.query("postgres", "select id from harness_probe where id = 2")).rowCount).toBe(0);
});

test("rule: checks the refusal text, fails when a bad action is accepted or refused for another reason", async () => {
  const dup = () => db.query("postgres", "insert into harness_probe values (1)");
  await rule({ refuse: dup, expect: "duplicate key" });
  await expect(rule({ refuse: dup, expect: "permission denied" })).rejects.toThrow("not as expected");
  await expect(rule({ refuse: () => db.query("postgres", "select 1") })).rejects.toThrow("accepted");
});
