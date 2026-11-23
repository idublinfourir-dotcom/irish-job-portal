// Integration: the fetched-job admin queue (src/admin-queue.ts, #166 to #168) on the real test database as app_admin, then every other app role
// against the same actions, and hostile input. The rules data is the fetcher's own files, loaded the way packages/fetcher/run/laptop.run.ts does.
// Fake names, fake adverts and fake staff only. No network: the matcher is the staff member's code.
import { readFileSync } from "node:fs";
import type pg from "pg";
import { CHAIN_RULES_V1, cleanEmployerName } from "@portal/rules";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { approve, claim, getItem, listQueue, QueueRefused, reject, release, type RulesData } from "../src/admin-queue";
import { getJob, PAGE_SIZE } from "../src/search";
import { createTestDb, race, type Role, type TestDb } from "./db";
import { fixtures } from "./fixtures";

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

const json = (name: string) => JSON.parse(readFileSync(new URL(`../../fetcher/data/${name}`, import.meta.url), "utf8")) as unknown;
const RULES: RulesData = {
  chain: {
    deteNames: new Set((json("L2/dete-2026.json") as [string, number][]).map(([n]) => cleanEmployerName(n))),
    publicPayCandidates: new Map(Object.entries(json("L2/public_employers_candidates.json") as Record<string, { tier: 1 | 2 }>).map(([k, v]) => [k, v.tier])),
    ...CHAIN_RULES_V1,
  },
  lists: json("occupation-lists.json") as RulesData["lists"],
};
const PAY = "Join our team building fake things. The salary is €60,000 a year.";

let db: TestDb;
let id: (prefix: string) => string;
let F: { org: () => Promise<number>; staff: () => Promise<string> };
/** Active staff holding the fetched_job_reviewer role: the only staff the queue accepts (#193). */
const reviewer = async () => {
  const i = await F.staff();
  await su("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1, 'fetched_job_reviewer', true)", [i]);
  return i;
};
let su: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
beforeAll(async () => {
  db = await createTestDb();
  ({ id, F, su } = fixtures(db) as unknown as { id: typeof id; F: typeof F; su: typeof su });
});
afterAll(() => db.drop());

const admin = () => db.pool("app_admin");

/** A fetched job the fetcher queued, as postgres: the trigger makes its fetched_job item. */
async function queued(o: { title?: string; text?: string | null; county?: string | null; kind?: string } = {}) {
  const src = (await su("insert into job_source(kind, board) values ($1, $2) returning id", [o.kind ?? "greenhouse", id("b")])).rows[0].id;
  const title = o.title ?? "Fixed-term Platform Engineer";
  const advert = (await su(
    "insert into fetched_advert(job_source_id, external_id, url, title, employer_name, result, stage, reason) values ($1, $2, 'https://jobs.example.test/a', $3, 'Acme Widgets', 'queued', '7 contract unclear (admin queue)', 'title') returning id::text",
    [src, id("ext"), title],
  )).rows[0].id as string;
  const org = await F.org();
  const job = (await su(
    `insert into job(organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, county, sector, occupation_code, permit_type, status, closes_at, search_vector, own_page_url)
     values ($1, 'fetched', $2, $3, $4, 'Acme Widgets', $5, 'IT', '2134', 'critical_skills', 'in_review', 'infinity', to_tsvector('english', $4), 'https://jobs.example.test/a') returning id::text`,
    [org, src, advert, title, o.county === undefined ? "Dublin" : o.county],
  )).rows[0].id as string;
  if (o.text !== null) await su("insert into job_text(job_id, advert_text) values ($1, $2)", [job, o.text ?? PAY]);
  const item = (await su("select id::text from review_item where queue = 'fetched_job' and job_id = $1", [job])).rows[0].id as string;
  return { job, item, advert, org };
}
const jobRow = async (job: string) => (await su("select status, close_reason, badge, pass_route, occupation_code, sector, salary_low, salary_high, posted_at, search_vector is not null as tsv from job where id = $1", [job])).rows[0];
const itemRow = async (item: string) => (await su("select status, claimed_by_staff_user_id, decided_by_staff_user_id, decided_at, outcome from review_item where id = $1", [item])).rows[0];
const audits = async (job: string) => (await su("select * from audit_event where object_type = 'job' and object_id = $1 order by id", [job])).rows;
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof QueueRefused ? (e.stage ? `${e.why}: ${e.stage}` : e.why) : `error: ${(e as Error).message}`;
  }
  return "accepted";
};
const claimed = async (o: Parameters<typeof queued>[0] = {}) => {
  const staff = await reviewer();
  const q = await queued(o);
  await claim(admin(), staff, q.item);
  return { ...q, staff };
};

describe("listQueue and getItem", () => {
  it("lists open and claimed fetched_job items oldest first, a page at a time, with what staff need", async () => {
    const mine: Awaited<ReturnType<typeof queued>>[] = [];
    for (let i = 0; i < PAGE_SIZE + 5; i++) mine.push(await queued({ title: `Fixed-term Platform Engineer ${i}` }));
    const staff = await reviewer();
    await claim(admin(), staff, mine[1]!.item);
    // a done item and another queue's item are not listed
    await su("update review_item set status = 'done', outcome = 'approved', decided_at = now() where id = $1", [mine[2]!.item]);
    const other = (await su("insert into review_item(queue, organisation_id, reason) values ('account_review', $1, 'fake') returning id::text", [await F.org()])).rows[0].id;
    await su("update organisation set sponsor_sort = 12, permit_history = 'has_history' where id = $1", [mine[0]!.org]);

    const seen: string[] = [];
    let page = await listQueue(admin(), staff);
    expect(page.items.length).toBe(PAGE_SIZE);
    for (;;) {
      seen.push(...page.items.map((x) => x.id));
      if (!page.next) break;
      page = await listQueue(admin(), staff, { after: page.next });
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(other);
    expect(seen).not.toContain(mine[2]!.item);
    const want = mine.filter((_, i) => i !== 2).map((m) => m.item);
    expect(seen.filter((s) => want.includes(s))).toEqual(want);

    const first = (await listQueue(admin(), staff)).items.find((x) => x.id === mine[0]!.item)!;
    expect(first).toMatchObject({
      status: "open", claimedBy: null, jobId: mine[0]!.job, title: "Fixed-term Platform Engineer 0", employerName: "Acme Widgets", advertUrl: "https://jobs.example.test/a",
      occupationCode: "2134", permitHistory: "has_history", sponsorPermits: 12, stage: "7 contract unclear (admin queue)", reason: "title",
    });
    const second = seen.includes(mine[1]!.item) && (await getItem(admin(), staff, mine[1]!.item));
    expect(second).toMatchObject({ status: "claimed", claimedBy: staff, advertText: PAY, sponsorPermits: null, permitHistory: "not_linked" });
  });

  it("getItem is null for another queue's item, an unknown id and anything that is not an id", async () => {
    const other = (await su("insert into review_item(queue, organisation_id, reason) values ('account_review', $1, 'fake') returning id::text", [await F.org()])).rows[0].id;
    const staff = await reviewer();
    for (const bad of [other, "999999999", "0", "-1", "1 or 1=1", "1e3", "99999999999999999999", "", "１２"]) expect(await getItem(admin(), staff, bad)).toBeNull();
  });

  it("refuses the list and the item to anyone but an active fetched_job_reviewer (#193, #234 D7): an administrator, an account reviewer, a disabled reviewer, no role, an unknown id", async () => {
    const q = await queued();
    const withRole = async (role: string) => { const i = await F.staff(); await su("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1, $2, true)", [i, role]); return i; };
    const disabled = await reviewer();
    await su("update staff_user set status = 'disabled' where id = $1", [disabled]);
    const codes: [string, string][] = [
      [await withRole("administrator"), "not_reviewer"], [await withRole("account_reviewer"), "not_reviewer"], [await F.staff(), "not_reviewer"],
      [disabled, "not_active_staff"], ["no-such-staff-member", "not_active_staff"], ["", "not_active_staff"], ["x".repeat(201), "not_active_staff"],
    ];
    for (const [staff, want] of codes) {
      expect(await refusal(listQueue(admin(), staff)), staff).toBe(want);
      expect(await refusal(getItem(admin(), staff, q.item)), staff).toBe(want);
    }
  });

  it("refuses a cursor it did not make", async () => {
    const forged = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const staff = await reviewer();
    for (const bad of ["x", "!!!", "a".repeat(500), forged({ t: "now", i: "1" }), forged({ t: "2026-11-11 10:00:00+00", i: "1; drop table job" }), forged(null), forged([1])])
      expect(await refusal(listQueue(admin(), staff, { after: bad }))).toBe("bad_cursor");
  });
});

describe("claim", () => {
  it("moves open to claimed by the staff member, again by the same person is a no-op, another person is refused", async () => {
    const [a, b] = [await reviewer(), await reviewer()];
    const q = await queued();
    await claim(admin(), a, q.item);
    expect(await itemRow(q.item)).toMatchObject({ status: "claimed", claimed_by_staff_user_id: a });
    await claim(admin(), a, q.item);
    expect(await refusal(claim(admin(), b, q.item))).toBe("claimed_by_other");
    expect((await itemRow(q.item)).claimed_by_staff_user_id).toBe(a);
  });

  it("of ten staff claiming at once, exactly one gets it", async () => {
    const staff = await Promise.all(Array.from({ length: 10 }, () => reviewer()));
    const q = await queued();
    const r = await race(10, (i) => claim(admin(), staff[i]!, q.item));
    expect(r.ok.length).toBe(1);
    expect(r.errors.every((e) => e.includes("claimed_by_other"))).toBe(true);
  });

  it("refuses a disabled or unknown staff member, and a decided item", async () => {
    const off = await reviewer();
    await su("update staff_user set status = 'disabled' where id = $1", [off]);
    const q = await queued();
    for (const who of [off, "no-such-staff", "", "x".repeat(5000)]) expect(await refusal(claim(admin(), who, q.item))).toBe("not_active_staff");
    expect((await itemRow(q.item)).status).toBe("open");
    const c = await claimed();
    await reject(admin(), c.staff, c.item, "not_a_real_job");
    expect(await refusal(claim(admin(), c.staff, c.item))).toBe("already_decided");
  });
});

describe("stale claims and release", () => {
  const itemAudits = async (item: string) =>
    (await su("select actor_staff_user_id, action, before, after from audit_event where object_type = 'review_item' and object_id = $1 order by id", [item])).rows;
  const age = (item: string, hours: number) => su(`update review_item set claimed_at = now() - interval '${hours} hours' where id = $1`, [item]);

  it("a claim under 24 hours old by an active staff member is not taken over", async () => {
    const c = await claimed();
    const b = await reviewer();
    await age(c.item, 23);
    expect(await refusal(claim(admin(), b, c.item))).toBe("claimed_by_other");
    expect((await itemRow(c.item)).claimed_by_staff_user_id).toBe(c.staff);
    expect(await itemAudits(c.item)).toEqual([]);
  });

  it("a claim over 24 hours old is taken over, with one audit row naming both", async () => {
    const c = await claimed();
    const b = await reviewer();
    await age(c.item, 25);
    await claim(admin(), b, c.item);
    expect(await itemRow(c.item)).toMatchObject({ status: "claimed", claimed_by_staff_user_id: b });
    expect(await itemAudits(c.item)).toEqual([
      { actor_staff_user_id: b, action: "fetched_job.take_over", before: { claimed_by_staff_user_id: c.staff }, after: { claimed_by_staff_user_id: b } },
    ]);
    // the old holder can no longer decide; the new one can
    expect(await refusal(reject(admin(), c.staff, c.item, "duplicate"))).toBe("not_claimer");
    await reject(admin(), b, c.item, "duplicate");
  });

  it("a disabled staff member's claim is taken over at once", async () => {
    const c = await claimed();
    await su("update staff_user set status = 'disabled' where id = $1", [c.staff]);
    const b = await reviewer();
    await claim(admin(), b, c.item);
    expect((await itemRow(c.item)).claimed_by_staff_user_id).toBe(b);
  });

  it("of five staff taking over one stale claim at once, exactly one gets it and one audit row is written", async () => {
    const c = await claimed();
    await age(c.item, 48);
    const staff = await Promise.all(Array.from({ length: 5 }, () => reviewer()));
    const r = await race(5, (i) => claim(admin(), staff[i]!, c.item));
    expect(r.ok.length).toBe(1);
    expect(r.errors.every((e) => e.includes("claimed_by_other"))).toBe(true);
    expect(await itemAudits(c.item)).toHaveLength(1);
  });

  it("the claimer can release an item back to open, with an audit row; then anyone can claim it", async () => {
    const c = await claimed();
    await release(admin(), c.staff, c.item);
    expect(await itemRow(c.item)).toMatchObject({ status: "open", claimed_by_staff_user_id: null });
    expect(await itemAudits(c.item)).toEqual([
      { actor_staff_user_id: c.staff, action: "fetched_job.release", before: { claimed_by_staff_user_id: c.staff }, after: { claimed_by_staff_user_id: null } },
    ]);
    const b = await reviewer();
    await claim(admin(), b, c.item);
    expect((await itemRow(c.item)).claimed_by_staff_user_id).toBe(b);
  });

  it("release is refused for someone else's claim, an open item, a decided item, a disabled or unknown staff member and odd ids", async () => {
    const c = await claimed();
    const b = await reviewer();
    expect(await refusal(release(admin(), b, c.item))).toBe("not_claimer");
    const q = await queued();
    expect(await refusal(release(admin(), b, q.item))).toBe("not_claimed");
    await reject(admin(), c.staff, c.item, "duplicate");
    expect(await refusal(release(admin(), c.staff, c.item))).toBe("already_decided");
    const d = await claimed();
    await su("update staff_user set status = 'disabled' where id = $1", [d.staff]);
    for (const who of [d.staff, "no-such-staff", ""]) expect(await refusal(release(admin(), who, d.item))).toBe("not_active_staff");
    for (const bad of ["0", "-1", "1 or 1=1", "99999999999999999999"]) expect(await refusal(release(admin(), b, bad))).toBe("not_found");
    expect(await itemRow(d.item)).toMatchObject({ status: "claimed", claimed_by_staff_user_id: d.staff });
  });
});

describe("approve", () => {
  it("goes live with the fetcher's columns, closes the item and writes one audit row, all together", async () => {
    const c = await claimed();
    const before = await jobRow(c.job);
    const r = await approve(admin(), c.staff, c.item, { occupationCode: "2136", contractConfirmed: true }, RULES);
    expect(r).toEqual({ jobId: c.job, passRoute: "stated_pay" });
    const j = await jobRow(c.job);
    expect(j).toMatchObject({ status: "live", close_reason: null, badge: "critical_skills_eligible", pass_route: "stated_pay", occupation_code: "2136", sector: "IT", salary_low: 60000, salary_high: 60000, tsv: true });
    expect(j.posted_at.getTime()).toBeGreaterThan(before.posted_at.getTime()); // job_guard: posted_at is the move into live
    expect(await itemRow(c.item)).toMatchObject({ status: "done", decided_by_staff_user_id: c.staff, outcome: "approved" });
    expect((await su("select result from fetched_advert where id = $1", [c.advert])).rows[0].result).toBe("passed");
    const a = await audits(c.job);
    expect(a.length).toBe(1);
    expect(a[0]).toMatchObject({
      kind: "admin_action", actor_staff_user_id: c.staff, action: "fetched_job.approve", object_type: "job", object_id: c.job, reason_code: "approved", source: "panel", reason_text: null,
      changed_columns: ["status", "badge", "pass_route", "occupation_code", "salary_low", "salary_high"],
      before: { status: "in_review", badge: null, pass_route: null, occupation_code: "2134", salary_low: null, salary_high: null },
      after: { status: "live", badge: "critical_skills_eligible", pass_route: "stated_pay", occupation_code: "2136", salary_low: 60000, salary_high: 60000 },
    });
    // the candidate site now shows it
    expect((await getJob(db.pool("app_candidate"), c.job))?.badge).toBe("critical_skills_eligible");
  });

  it("re-runs the rules: a failed stage is refused with the stage, and the item stays claimed with nothing written", async () => {
    const cases: [Parameters<typeof queued>[0], Parameters<typeof approve>[3], string][] = [
      [{}, { occupationCode: "2134" }, "7 contract unclear (admin queue)"],
      [{ title: "Platform Engineer", text: "A permanent or specified purpose. Salary €60,000." }, { occupationCode: "2134" }, "7 permanent or specified purpose (admin queue, #95)"],
      [{ title: "Platform Engineer", text: "A 12 month contract. Salary €60,000." }, { occupationCode: "2134", contractConfirmed: true }, "7 contract under 2 years"],
      [{ title: "Platform Engineer", text: "Salary €30,000." }, { occupationCode: "2134" }, "8 salary below €40,904"],
      [{ title: "Platform Engineer", text: "No pay is mentioned." }, { occupationCode: "2134" }, "8 no salary, not a big company"],
      [{ title: "Platform Engineer" }, { occupationCode: "1225" }, "6 not on Critical Skills list"],
      [{ title: "Platform Engineer", text: `${PAY} You must pay a registration fee before starting.` }, { occupationCode: "2134" }, "0 scam wording (admin queue)"],
      [{ title: "Platform Engineer", text: "Salary €60,000.", county: null }, { occupationCode: "2134", salaryLow: 30000 }, "8 salary below €40,904"],
    ];
    for (const [job, input, stage] of cases) {
      const c = await claimed(job);
      expect(await refusal(approve(admin(), c.staff, c.item, input, RULES))).toBe(`rules_failed: ${stage}`);
      expect(await itemRow(c.item)).toMatchObject({ status: "claimed", claimed_by_staff_user_id: c.staff, outcome: null });
      expect((await jobRow(c.job)).status).toBe("in_review");
      expect(await audits(c.job)).toEqual([]);
    }
  });

  it("contractConfirmed clears only the contract stages, and staff pay stands in for pay the text does not state", async () => {
    const a = await claimed({ title: "Platform Engineer", text: "A permanent or specified purpose. Salary €60,000." });
    expect((await approve(admin(), a.staff, a.item, { occupationCode: "2134", contractConfirmed: true }, RULES)).passRoute).toBe("stated_pay");
    const b = await claimed({ title: "Platform Engineer", text: "Pay is discussed at interview.", county: null });
    await approve(admin(), b.staff, b.item, { occupationCode: "2134", salaryLow: 50000, salaryHigh: 58000 }, RULES);
    expect(await jobRow(b.job)).toMatchObject({ status: "live", salary_low: 50000, salary_high: 58000, pass_route: "stated_pay" });
  });

  it("only the claimer decides, an open item is not decided, and two decisions at once give one", async () => {
    const other = await reviewer();
    const c = await claimed();
    const input = { occupationCode: "2134", contractConfirmed: true };
    expect(await refusal(approve(admin(), other, c.item, input, RULES))).toBe("not_claimer");
    expect(await refusal(reject(admin(), other, c.item, "duplicate"))).toBe("not_claimer");
    const open = await queued();
    expect(await refusal(approve(admin(), other, open.item, input, RULES))).toBe("not_claimed");
    const r = await race<unknown>(6, (i) => (i % 2 ? approve(admin(), c.staff, c.item, input, RULES) : reject(admin(), c.staff, c.item, "duplicate")));
    expect(r.ok.length).toBe(1);
    expect(r.errors.every((e) => e.includes("already_decided"))).toBe(true);
    expect(await audits(c.job)).toHaveLength(1);
  });

  it("refuses a job that is no longer in review and an item whose advert text is gone", async () => {
    const c = await claimed();
    await su("update job set status = 'closed', close_reason = 'closed' where id = $1", [c.job]);
    expect(await refusal(approve(admin(), c.staff, c.item, { occupationCode: "2134", contractConfirmed: true }, RULES))).toBe("job_not_in_review");
    const d = await claimed({ text: null });
    expect(await refusal(approve(admin(), d.staff, d.item, { occupationCode: "2134", contractConfirmed: true }, RULES))).toBe("no_advert_text");
  });
});

describe("reject", () => {
  it("closes the job the way a staff removal does, closes the item and writes one audit row with the reason code", async () => {
    const c = await claimed();
    await reject(admin(), c.staff, c.item, "not_a_real_job");
    expect(await jobRow(c.job)).toMatchObject({ status: "closed", close_reason: "removed", badge: null });
    expect(await itemRow(c.item)).toMatchObject({ status: "done", decided_by_staff_user_id: c.staff, outcome: "rejected" });
    expect((await su("select result from fetched_advert where id = $1", [c.advert])).rows[0].result).toBe("rejected");
    const a = await audits(c.job);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: "fetched_job.reject", reason_code: "not_a_real_job", reason_text: null, changed_columns: ["status", "close_reason"], before: { status: "in_review", close_reason: null }, after: { status: "closed", close_reason: "removed" } });
  });
});

describe("statement budget", () => {
  /** Counts the statements an action sends, on the pool and on each checked-out client. */
  const counting = (pool: pg.Pool) => {
    const sql: string[] = [];
    const wrap = <T extends { query: (...a: never[]) => unknown }>(o: T) => ((text: string, values?: unknown[]) => (sql.push(text), (o.query as (...a: unknown[]) => unknown).call(o, text, values))) as unknown as T["query"];
    return {
      sql,
      db: { query: wrap(pool), connect: async () => { const c = await pool.connect(); return Object.assign(Object.create(c), { query: wrap(c), release: () => c.release() }); } } as unknown as pg.Pool,
    };
  };
  it("listQueue is three statements (the role check, the page and the stage counts), claim four, approve and reject five each (begin, acting staff, lock, write, commit)", async () => {
    const c = await claimed();
    const m = counting(admin());
    await listQueue(m.db, c.staff);
    expect(m.sql).toHaveLength(3);
    m.sql.length = 0;
    const q = await queued();
    await claim(m.db, c.staff, q.item);
    expect(m.sql).toHaveLength(4);
    m.sql.length = 0;
    await approve(m.db, c.staff, c.item, { occupationCode: "2134", contractConfirmed: true }, RULES);
    expect(m.sql).toHaveLength(5);
    m.sql.length = 0;
    await reject(m.db, c.staff, q.item, "duplicate");
    expect(m.sql).toHaveLength(5);
  });
  it("release is four statements, taking over a stale claim six (begin, acting staff, claim, state, take over, commit)", async () => {
    const c = await claimed();
    const m = counting(admin());
    await release(m.db, c.staff, c.item);
    expect(m.sql).toHaveLength(4);
    await claim(admin(), c.staff, c.item);
    await su("update review_item set claimed_at = now() - interval '48 hours' where id = $1", [c.item]);
    m.sql.length = 0;
    await claim(m.db, await reviewer(), c.item);
    expect(m.sql).toHaveLength(6);
  });
});

describe("security", () => {
  const OTHERS: Role[] = ["app_portal", "app_candidate", "app_fetcher", "anon", "authenticated"];
  it.each(OTHERS)("%s cannot list, read, claim, take over, release, approve or reject", async (role) => {
    const c = await claimed();
    const q = await queued();
    const stale = await claimed();
    await su("update review_item set claimed_at = now() - interval '48 hours' where id = $1", [stale.item]);
    const p = db.pool(role);
    const results = [
      await refusal(listQueue(p, c.staff)), await refusal(getItem(p, c.staff, q.item)), await refusal(claim(p, c.staff, q.item)),
      await refusal(claim(p, c.staff, stale.item)), await refusal(release(p, c.staff, c.item)),
      await refusal(approve(p, c.staff, c.item, { occupationCode: "2134", contractConfirmed: true }, RULES)), await refusal(reject(p, c.staff, c.item, "duplicate")),
    ];
    for (const r of results) expect(r).toMatch(/^error: permission denied/);
    expect(await itemRow(q.item)).toMatchObject({ status: "open" });
    expect(await itemRow(c.item)).toMatchObject({ status: "claimed", claimed_by_staff_user_id: c.staff });
    expect((await itemRow(stale.item)).claimed_by_staff_user_id).toBe(stale.staff);
    expect((await jobRow(c.job)).status).toBe("in_review");
  });

  it("a disabled staff member cannot decide, even an item they claimed before", async () => {
    const c = await claimed();
    await su("update staff_user set status = 'disabled' where id = $1", [c.staff]);
    expect(await refusal(approve(admin(), c.staff, c.item, { occupationCode: "2134", contractConfirmed: true }, RULES))).toBe("not_active_staff");
    expect(await refusal(reject(admin(), c.staff, c.item, "duplicate"))).toBe("not_active_staff");
    expect((await jobRow(c.job)).status).toBe("in_review");
  });

  it("refuses hostile occupation codes, salaries and reasons before touching the database", async () => {
    const c = await claimed();
    const codes: unknown[] = ["", "213", "21345", "abcd", "2134 ", "2134; drop table job", "２１３４", "9999", "0000", "x".repeat(100000), 2134, null, undefined, {}];
    for (const occupationCode of codes)
      expect(await refusal(approve(admin(), c.staff, c.item, { occupationCode } as never, RULES))).toBe("bad_occupation_code");
    const pays: [unknown, unknown][] = [[-1, undefined], [0, undefined], [1.5, undefined], [1e12, undefined], [Number.NaN, undefined], [Infinity, undefined], ["50000", undefined], [undefined, 60000], [60000, 50000], [50000, 2 ** 31]];
    for (const [salaryLow, salaryHigh] of pays)
      expect(await refusal(approve(admin(), c.staff, c.item, { occupationCode: "2134", salaryLow, salaryHigh } as never, RULES))).toBe("bad_salary");
    expect(await refusal(approve(admin(), c.staff, c.item, { occupationCode: "2134", contractConfirmed: "yes" } as never, RULES))).toBe("bad_input");
    expect(await refusal(approve(admin(), c.staff, c.item, null as never, RULES))).toBe("bad_input");
    for (const reason of ["", "Not a real job", "a".repeat(64), "x'; drop table job; --", "UPPER", "1code", null])
      expect(await refusal(reject(admin(), c.staff, c.item, reason as never))).toBe("bad_reason");
    expect(await itemRow(c.item)).toMatchObject({ status: "claimed" });
    expect(await audits(c.job)).toEqual([]);
  });

  it("refuses odd item ids and items of other queues as not found", async () => {
    const staff = await reviewer();
    const flag = (await su("insert into review_item(queue, organisation_id, reason) values ('account_review', $1, 'fake') returning id::text", [await F.org()])).rows[0].id;
    // a scam_flag item on a fetched job: the same job, another queue
    const q = await queued();
    const scam = (await su("insert into review_item(queue, job_id, reason) values ('scam_flag', $1, 'fake') returning id::text", [q.job])).rows[0].id;
    for (const bad of [flag, scam, "0", "-1", "1 or 1=1", "99999999999999999999", "", "1.5", " 1"]) {
      expect(await refusal(claim(admin(), staff, bad))).toBe("not_found");
      expect(await refusal(approve(admin(), staff, bad, { occupationCode: "2134" }, RULES))).toBe("not_found");
      expect(await refusal(reject(admin(), staff, bad, "duplicate"))).toBe("not_found");
    }
    expect((await su("select status from review_item where id = any($1::bigint[])", [[flag, scam]])).rows.map((r) => r.status)).toEqual(["open", "open"]);
  });
});

describe("roles: only an active fetched_job_reviewer (#193)", () => {
  const withRole = async (...roles: string[]) => {
    const i = await F.staff();
    for (const r of roles) await su("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1, $2, true)", [i, r]);
    return i;
  };
  const snapshot = async (q: { job: string; item: string }) =>
    JSON.stringify([await jobRow(q.job), await itemRow(q.item), (await su("select count(*)::int n from audit_event")).rows[0].n]);
  const everyAction = (who: string, item: string) =>
    Promise.all([
      refusal(claim(admin(), who, item)), refusal(release(admin(), who, item)),
      refusal(approve(admin(), who, item, { occupationCode: "2134", contractConfirmed: true }, RULES)), refusal(reject(admin(), who, item, "duplicate")),
    ]);

  it("claim, release, approve and reject refuse account_reviewer only, administrator only and no role, and change nothing", async () => {
    const c = await claimed();
    const before = await snapshot(c);
    for (const roles of [["account_reviewer"], ["administrator"], ["account_reviewer", "administrator", "rules_data_editor"], []])
      expect(await everyAction(await withRole(...roles), c.item), roles.join()).toEqual(Array(4).fill("not_reviewer"));
    expect(await snapshot(c)).toBe(before);
  });

  it("a disabled staff member holding the role is not_active_staff (before not_reviewer), on every action", async () => {
    const c = await claimed();
    const off = await reviewer();
    await su("update staff_user set status = 'disabled' where id = $1", [off]);
    const noRole = await F.staff();
    await su("update staff_user set status = 'disabled' where id = $1", [noRole]);
    const before = await snapshot(c);
    for (const who of [off, noRole]) expect(await everyAction(who, c.item)).toEqual(Array(4).fill("not_active_staff"));
    expect(await snapshot(c)).toBe(before);
  });

  it("accepts fetched_job_reviewer alone, and with other roles beside it", async () => {
    const [a, b] = [await withRole("fetched_job_reviewer"), await withRole("fetched_job_reviewer", "administrator", "account_reviewer")];
    const q = await queued();
    await claim(admin(), a, q.item);
    await release(admin(), a, q.item);
    await claim(admin(), b, q.item);
    await reject(admin(), b, q.item, "duplicate");
    expect(await itemRow(q.item)).toMatchObject({ status: "done", outcome: "rejected", decided_by_staff_user_id: b });
  });

  it("a role granted then removed: the next action is refused, the earlier claim stays untouched", async () => {
    const who = await withRole("fetched_job_reviewer");
    const q = await queued();
    await claim(admin(), who, q.item);
    await su("delete from staff_role where staff_user_id = $1 and role = 'fetched_job_reviewer'", [who]);
    const before = await snapshot(q);
    expect(await everyAction(who, q.item)).toEqual(Array(4).fill("not_reviewer"));
    expect(await snapshot(q)).toBe(before);
    await su("insert into staff_role(staff_user_id, role, seeded_by_owner) values ($1, 'fetched_job_reviewer', true)", [who]);
    await release(admin(), who, q.item);
    expect((await itemRow(q.item)).status).toBe("open");
  });

  it("hostile staff ids are refused as not_active_staff on every action and change nothing", async () => {
    const c = await claimed();
    const before = await snapshot(c);
    for (const bad of ["", "x".repeat(5000), "nobody", "1' or '1'='1", "s'; insert into staff_role values ('a','fetched_job_reviewer'); --", undefined, null, 5])
      expect(await everyAction(bad as never, c.item), String(bad)).toEqual(Array(4).fill("not_active_staff"));
    expect(await snapshot(c)).toBe(before);
  });
});
