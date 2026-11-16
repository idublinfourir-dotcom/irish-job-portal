// Performance: the backup's counting step (backup-cli.ts countTables) as app_backup, on a database the size of the live one's biggest tables:
// 100,000 cro_company rows (the 88 MB table), 20,000 candidates, 100,000 outbox rows. It must be one statement and finish in a time budget,
// and every table must be counted. Fake data only.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { countTables } from "../../src/backup-cli.ts";
import { createTestDb, type TestDb } from "../db";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
export const STATEMENTS = 1;
export const COUNT_MS = 250; // measured 13 to 16 ms on 16 Nov 2026 (64 tables, 220,000 rows in the big three), about 15 times that, for a busy machine
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  const su = db.pool("postgres");
  await su.query("insert into cro_company(cro_number,name,normalised_name,status,last_seen_on) select (900000+g)::text,'Fake Company '||g||' Limited','fake company '||g,'Normal',now() from generate_series(1,100000) g");
  await su.query("insert into candidate_user(id,name,email,email_verified,updated_at) select 'c'||g,'Fake','c'||g||'@example.test',true,now() from generate_series(1,20000) g");
  await su.query("insert into email_outbox(template,candidate_user_id,status,attempts,sent_at,dedupe_key) select 't','old'||g,'sent',1,now(),'old'||g from generate_series(1,100000) g");
  await su.query("analyze");
});
afterAll(() => db.drop());

it("counts every table in one statement within the time budget", async () => {
  const c = await db.pool("app_backup").connect();
  try {
    let statements = 0;
    const counted = { query: (...a: Parameters<typeof c.query>) => (statements++, c.query(...a)) } as unknown as typeof c;
    await c.query("begin isolation level repeatable read, read only");
    await countTables(c); // warm: the first call loads the catalog caches
    statements = 0;
    const t = performance.now();
    const rows = await countTables(counted);
    const ms = performance.now() - t;
    await c.query("commit");
    console.log("count tables", rows.length, "tables,", statements, "statement,", Math.round(ms), "ms");
    expect(rows.find((r) => r.name === "public.cro_company")?.rows).toBe(100000);
    expect(rows.find((r) => r.name === "public.email_outbox")?.rows).toBe(100000);
    expect(rows.length).toBeGreaterThan(50);
    expect(statements).toBe(STATEMENTS);
    expect(ms).toBeLessThan(COUNT_MS);
  } finally {
    c.release();
  }
});
