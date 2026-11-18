// Integration: the company seed (D2, #246) through the real command, main(argv, env, log), against the real test database with the owner login
// (portal_owner); app_admin is refused by the database without a confirmed company_seed request (0047).
// Fake names only. The fetcher side (a fetched advert under a seeded brand name) is in packages/db/test/seeded-employer.test.ts.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../src/company-seed-cli";
import { importPermits, refreshPermitHistory } from "../src/dete";
import { createTestDb, urlFor, type TestDb } from "./db";
import { fixtures } from "./fixtures";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db: TestDb;
let id: (prefix: string) => string;
let su: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
beforeAll(async () => {
  db = await createTestDb();
  ({ id, su } = fixtures(db) as unknown as { id: typeof id; su: typeof su });
});
afterAll(() => db.drop());

const dir = mkdtempSync(join(tmpdir(), "company-seed-"));
const HEAD = "display_name\tkind\tbrand_names\tdete_names";
const write = (...rows: string[]) => {
  const f = join(dir, `${id("f")}.tsv`);
  writeFileSync(f, [HEAD, ...rows].join("\n") + "\n");
  return f;
};
const ENV = (role = "portal_owner") => ({ SEED_OWNER_DATABASE_URL: urlFor(db.name, role), DATABASE_SSL: "disable" });
async function seed(file: string, env: Record<string, string> = ENV()) {
  const out: string[] = [];
  const code = await main([file], env, (l) => out.push(l));
  return { code, out };
}
const permits = (deteName: string, year: number, n: number) => importPermits(db.pool("app_admin"), [{ deteName, year, permits: n, sourceFile: "fake.xlsx" }]);
const orgsNamed = async (display: string) => (await su("select * from organisation where display_name = $1", [display])).rows;
const namesOf = async (org: string) => (await su("select name, normalised_name, kind, source from organisation_name where organisation_id = $1 order by id", [org])).rows;
const linksOf = async (deteName: string) => (await su("select n.organisation_id::text as org, d.organisation_name_id::text as name_id from dete_permit_count d left join organisation_name n on n.id = d.organisation_name_id where d.dete_name = $1 order by d.id", [deteName])).rows;
/** A company the way the fetcher makes one: unclaimed employer with one alias from job_site. */
async function fetcherOrg(name: string) {
  const norm = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const org = (await su("insert into organisation(slug, display_name, kind) values ($1, $2, 'employer') returning id::text", [norm.replace(/ /g, "-"), name])).rows[0].id;
  await su("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, $2, $3, 'alias', 'job_site')", [org, name, norm]);
  return org as string;
}
const snapshot = async () => (await su(
  "select (select json_agg(o order by o.id) from organisation o) as orgs, (select json_agg(n order by n.id) from organisation_name n) as names, " +
  "(select json_agg(json_build_array(d.id, d.organisation_name_id) order by d.id) from dete_permit_count d) as links")).rows[0];

describe("company seed", () => {
  it("makes new companies with their names and DETE links, sets the label, and a second run writes nothing", async () => {
    const p = id("Fakeco");
    await permits(`${p} Ireland Limited`, 2025, 7);
    await permits(`${p} Ireland Limited`, 2026, 3);
    await permits(`${p} Ltd.`, 2024, 2);
    const f = write(`${p} Group\temployer\t${p} ;; ${p} Careers\t${p} Ireland Limited ;; ${p} Ltd. ;; ${p} Missing Ltd`, `${p} Board\tpublic_body\t${p} Board\t`);
    const first = await seed(f);
    expect(first.code).toBe(0);
    expect(first.out).toEqual([
      "2 companies new, 0 found existing, 6 names added, 3 DETE rows linked, 0 refused",
      "1 permit history labels changed",
      `  DETE name not found: ${p} Missing Ltd`,
    ]);
    const [org] = await orgsNamed(`${p} Group`);
    expect(org).toMatchObject({ kind: "employer", status: "unclaimed", signup_path: "admin", is_big_company: false, cro_number: null, website: null, claimed_at: null, permit_history: "has_history", sponsor_sort: 12 });
    expect(org.slug).toBe(`${p.toLowerCase()}-group`);
    const lower = p.toLowerCase().replace(/[^a-z0-9]+/g, " ");
    expect(await namesOf(org.id)).toEqual([
      { name: `${p} Ireland Limited`, normalised_name: `${lower} ireland limited`, kind: "legal", source: "dete" },
      { name: `${p} Ltd.`, normalised_name: `${lower} ltd`, kind: "legal", source: "dete" },
      { name: `${p} Missing Ltd`, normalised_name: `${lower} missing ltd`, kind: "legal", source: "dete" },
      { name: p, normalised_name: lower, kind: "alias", source: "admin" },
      { name: `${p} Careers`, normalised_name: `${lower} careers`, kind: "alias", source: "admin" },
    ]);
    for (const l of [...(await linksOf(`${p} Ireland Limited`)), ...(await linksOf(`${p} Ltd.`))]) expect(l.org).toBe(String(org.id));
    expect((await orgsNamed(`${p} Board`))[0]).toMatchObject({ kind: "public_body", status: "unclaimed", signup_path: "admin", permit_history: "not_linked" });

    const before = await snapshot();
    const again = await seed(f);
    expect(again.out[0]).toBe("0 companies new, 2 found existing, 0 names added, 0 DETE rows linked, 0 refused");
    expect(again.out[1]).toBe("0 permit history labels changed");
    expect(await snapshot()).toEqual(before);
  });

  it("finds a company the fetcher made by its brand name and gives it the new names, not a second company", async () => {
    const p = id("Fetchedco");
    const org = await fetcherOrg(`${p} Ltd`);
    await permits(`${p} Holdings DAC`, 2026, 4);
    const r = await seed(write(`${p}\tpublic_body\t${p} Ltd ;; ${p}\t${p} Holdings DAC`));
    expect(r.out[0]).toBe("0 companies new, 1 found existing, 2 names added, 1 DETE rows linked, 0 refused");
    expect(r.out).toContain(`  line 2 (${p}): company ${org} is employer, the file says public_body; kind not changed`);
    expect(await orgsNamed(p)).toEqual([]);
    expect((await namesOf(org)).map((n) => [n.kind, n.source])).toEqual([["alias", "job_site"], ["legal", "dete"], ["alias", "admin"]]);
    expect((await linksOf(`${p} Holdings DAC`))[0]!.org).toBe(org);
    expect((await su("select permit_history from organisation where id = $1", [org])).rows[0].permit_history).toBe("has_history");
  });

  it("never re-points a DETE name linked to another company, and refuses that row", async () => {
    const p = id("Linkedco");
    const other = await fetcherOrg(`${p} Other`);
    await permits(`${p} Shared Ltd`, 2025, 5);
    await su("update dete_permit_count set organisation_name_id = (select id from organisation_name where organisation_id = $1) where dete_name = $2", [other, `${p} Shared Ltd`]);
    await refreshPermitHistory(db.pool("app_admin"));
    const before = await snapshot();
    const r = await seed(write(`${p} New\temployer\t${p} New\t${p} Shared Ltd`));
    expect(r.out[0]).toBe("0 companies new, 0 found existing, 0 names added, 0 DETE rows linked, 1 refused");
    expect(r.out[2]).toMatch(new RegExp(`refused: line 2 \\(${p} New\\): the DETE name "${p} Shared Ltd" is linked to another company`));
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a row whose names belong to two companies, and two rows on one company or one name form", async () => {
    const p = id("Twoco");
    const alpha = await fetcherOrg(`${p} Alpha`);
    await su("insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, $2, btrim(regexp_replace(lower($2), '[^a-z0-9]+', ' ', 'g')), 'alias', 'admin')", [alpha, `${p} Alpha2`]);
    await fetcherOrg(`${p} Beta`);
    const before = await snapshot();
    const r = await seed(write(
      `${p} Both\temployer\t${p} Alpha\t${p} BETA`, // two companies
      `${p} Gamma\temployer\t${p} Gamma\t`, `${p} Gamma Two\temployer\t${p}-gamma\t`, // one name form ("... gamma") on two rows
    ));
    expect(r.out[0]).toBe("0 companies new, 0 found existing, 0 names added, 0 DETE rows linked, 3 refused");
    expect(r.out[2]).toMatch(/refused: line 2 .*belong to 2 companies.*staff merge them first/);
    expect(r.out[3]).toMatch(/refused: line 3 .*is also on line 4/);
    expect(r.out[4]).toMatch(/refused: line 4 .*is also on line 3/);
    expect(await snapshot()).toEqual(before);
    const twoRows = await seed(write(`${p} A1\temployer\t${p} Alpha\t`, `${p} A2\temployer\t${p} Alpha2\t`)); // two names of one company
    expect(twoRows.out[0]).toMatch(/0 found existing, 0 names added, 0 DETE rows linked, 2 refused$/);
    expect(twoRows.out[2]).toMatch(new RegExp(`refused: line 2 .*another line reaches the same company ${alpha}`));
  });

  it("refuses the whole file on one bad line: nothing written", async () => {
    const p = id("Badfile");
    const before = await snapshot();
    const r = await seed(write(`${p} Good\temployer\t${p} Good\t`, `${p} Bad\tcharity\t${p} Bad\t`));
    expect(r.code).toBe(1);
    expect(r.out[0]).toMatch(/is refused, nothing was written:\nline 3: kind must be/);
    expect(await snapshot()).toEqual(before);
  });

  it("adds -2 to a slug that is taken, as register_organisation does", async () => {
    const p = id("Slugco");
    await su("insert into organisation(slug, display_name, kind) values ($1, 'Someone Else', 'employer')", [`${p.toLowerCase()}`]);
    await seed(write(`${p}\temployer\t${p} Brand\t`));
    expect((await orgsNamed(p))[0].slug).toBe(`${p.toLowerCase()}-2`);
  });
});

describe("security", () => {
  it("refuses without SEED_OWNER_DATABASE_URL, and the other logins cannot run it", async () => {
    const p = id("Sec");
    const f = write(`${p}\temployer\tX Brand\t`);
    expect(await seed(f, {})).toEqual({ code: 2, out: ["SEED_OWNER_DATABASE_URL is not set (the owner login, portal_owner)"] });
    for (const role of ["app_portal", "app_candidate", "app_fetcher"]) await expect(seed(f, ENV(role)), role).rejects.toThrow(/permission denied/);
    // app_admin alone: the two-person rule (0047), nothing written
    await expect(seed(f, ENV("app_admin"))).rejects.toThrow(/two-person rule: organisation rows are added only by a confirmed company_seed request/);
    expect(await orgsNamed(p)).toEqual([]);
  });

  it("the portal, candidate and fetcher logins cannot write admin or dete names, or set a DETE link", async () => {
    const org = await fetcherOrg(id("Roles"));
    await permits(`${org} roles`, 2026, 1);
    const nameId = (await su("select id from organisation_name where organisation_id = $1", [org])).rows[0].id;
    const ins = "insert into organisation_name(organisation_id, name, normalised_name, kind, source) values ($1, $2, $2, $3, $4)";
    for (const role of ["app_portal", "app_candidate", "app_fetcher"] as const) {
      for (const [kind, source] of [["legal", "dete"], ["alias", "admin"], ["legal", "admin"], ["alias", "dete"]])
        await expect(db.query(role, ins, [org, id(`n ${role}`), kind, source]), `${role} ${kind} ${source}`).rejects.toThrow(role === "app_fetcher" ? /the fetcher writes only alias names from job_site/ : /permission denied/);
      await expect(db.query(role, "update dete_permit_count set organisation_name_id = $1 where dete_name = $2", [nameId, `${org} roles`]), role).rejects.toThrow(/permission denied/);
    }
    await db.query("app_fetcher", ins, [org, id("n ok"), "alias", "job_site"]); // the fetcher's own write still works
    await expect(db.query("app_fetcher", "update organisation_name set source = 'dete' where organisation_id = $1", [org])).rejects.toThrow(/permission denied/);
  });

  it("stores hostile text as plain text, and refuses hidden characters and a huge file", async () => {
    const p = id("Hostile");
    const sql = `${p} '); delete from organisation; --`;
    const r = await seed(write(`${sql}\temployer\t${sql}\t`));
    expect(r.out[0]).toBe("1 companies new, 0 found existing, 1 names added, 0 DETE rows linked, 0 refused");
    expect((await orgsNamed(sql))[0].slug).toBe(`${p.toLowerCase()}-delete-from-organisation`);
    expect(Number((await su("select count(*) from organisation")).rows[0].count)).toBeGreaterThan(1);
    for (const bad of [`${p} ‮Ltd`, `${p}​ Ltd`, `${p} ${"x".repeat(10_000)}`]) {
      const x = await seed(write(`${p} H\temployer\t${bad}\t`));
      expect(x.code, JSON.stringify(bad.slice(0, 40))).toBe(1);
    }
    const huge = join(dir, "huge.tsv");
    writeFileSync(huge, HEAD + "\n" + `${p}\temployer\t${p}\t\n`.repeat(40_000));
    expect(await seed(huge)).toEqual({ code: 1, out: [`${huge} is refused, nothing was written:\nthe file is over 1000000 bytes`] });
  });

  it("a seeded company is unclaimed and is claimed only through claim_organisation with its checks", async () => {
    const p = id("Claimco");
    await seed(write(`${p}\temployer\t${p}\t`));
    const [org] = await orgsNamed(p);
    expect(org.status).toBe("unclaimed");
    await expect(db.query("app_portal", "update organisation set status = 'verified' where id = $1", [org.id])).rejects.toThrow(/permission denied/);
    const user = async (verified: boolean) => {
      const u = id("u");
      await su("insert into portal_user(id,name,email,email_verified,created_at,updated_at) values($1,'Fake Member',$2,$3,now(),now())", [u, `${u}@example.test`, verified]);
      return u;
    };
    await expect(db.query("app_portal", "select private.claim_organisation($1, $2)", [await user(false), org.id])).rejects.toThrow(/email not verified/);
    const r = (await db.query("app_portal", "select private.claim_organisation($1, $2) r", [await user(true), org.id])).rows[0].r;
    expect(r.status).toBe("pending_review"); // no seeded domain, so staff review it
    expect((await orgsNamed(p))[0]).toMatchObject({ status: "pending_review", signup_path: "dete_claim" });
    expect(Number((await su("select count(*) from review_item where organisation_id = $1 and queue = 'account_review'", [org.id])).rows[0].count)).toBe(1);
  });
});
