// W1: Workday boards one at a time a pause apart, the stop after repeated 429, the run's verdict, and the wait budget of a whole run.
// Unit: a fake Db (no database), fake fetch (no network), a sleep that only records (no real waiting).
import { describe, expect, it } from "vitest";
import { FetchFailedError, PACE, type Fetch } from "@portal/sources";
import { deps, plan } from "../test/helpers";
import { atsTasks, runBoards, runFailure, type BoardReport, type BoardTask, type Db } from "./index";

// Answers every statement like an empty board: one id, nothing known.
const query = async (sql: string) => ({ rows: sql.startsWith("select external_id") ? [] : [{ id: "1" }] });
const db = { query, connect: async () => ({ query, release: () => {} }) } as unknown as Db;
const recorder = () => {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
};
const tick = async (n = 5) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** A task that counts how many of its group are open at once, and fails with `error` if given. */
function tracked(kind: string, board: string, open: { now: number; max: number }, error?: string, called?: string[]): BoardTask {
  return {
    kind, board, serial: kind === "workday",
    fetch: async () => {
      called?.push(board);
      open.max = Math.max(open.max, ++open.now);
      await tick();
      open.now--;
      if (error) throw new FetchFailedError(board, error);
      return { seen: [], adverts: [] };
    },
  };
}

describe("the serial lane", () => {
  it("runs Workday boards one at a time while the other kinds still run in parallel", async () => {
    const wd = { now: 0, max: 0 }, gh = { now: 0, max: 0 };
    const boards = [...Array.from({ length: 5 }, (_, i) => tracked("workday", `w${i}`, wd)), ...Array.from({ length: 6 }, (_, i) => tracked("greenhouse", `g${i}`, gh))];
    const { waits, sleep } = recorder();
    const reports = await runBoards(deps(db, boards, { sleep }));
    expect(reports.every((r) => r.ok)).toBe(true);
    expect(wd.max).toBe(1);
    expect(gh.max).toBeGreaterThan(1);
    expect(waits).toEqual([1500, 1500, 1500, 1500]); // between the 5 Workday boards only
  });
  it("after 2 boards in a row give up on 429, the rest fail without a request", async () => {
    const called: string[] = [];
    const open = { now: 0, max: 0 };
    const boards = ["w0", "w1", "w2", "w3"].map((b) => tracked("workday", b, open, "HTTP 429 after 3 tries (server cloudflare)", called));
    const { waits, sleep } = recorder();
    const reports = await runBoards(deps(db, boards, { sleep }));
    expect(called).toEqual(["w0", "w1"]);
    expect(reports.map((r) => r.error?.slice(0, 26))).toEqual(["HTTP 429 after 3 tries (se", "HTTP 429 after 3 tries (se", "skipped after repeated 429", "skipped after repeated 429"]);
    expect(waits).toEqual([1500]); // no pause before a skipped board
  });
  it("a board that works, or fails another way, resets the count", async () => {
    const called: string[] = [];
    const open = { now: 0, max: 0 };
    const e429 = "HTTP 429 after 3 tries", e503 = "HTTP 503 after 3 tries";
    const plan = [e429, undefined, e503, "HTTP 500", e429, e429, e429];
    const boards = plan.map((e, i) => tracked("workday", `w${i}`, open, e, called));
    await runBoards(deps(db, boards, { sleep: recorder().sleep }));
    expect(called).toEqual(["w0", "w1", "w2", "w3", "w4", "w5"]); // w4 and w5 in a row stop w6
  });
});

describe("runFailure: when the run as a whole ends red", () => {
  const r = (kind: string, ok: boolean): BoardReport => ({ kind, board: "b", ok, error: ok ? null : "x", seen: 0, passed: 0, queued: 0, rejected: 0, changed: 0, closed: 0, unsaved: [] });
  it.each([
    ["all good", [r("greenhouse", true), r("workday", true)], null],
    ["one board of a kind with others working", [r("workday", false), r("workday", true), r("greenhouse", true)], null],
    ["every Workday board failed", [r("workday", false), r("workday", false), r("greenhouse", true), r("greenhouse", true), r("ashby", true)], "every workday board failed (2 of 5 boards failed)"],
    ["half failed, across kinds: not more than half", [r("a", false), r("b", true), r("a", true), r("b", false)], null],
    ["more than half failed", [r("a", false), r("b", false), r("a", true), r("b", false), r("a", false), r("b", true)], "4 of 6 boards failed"],
    ["the single Amazon board failed", [r("amazon", false), r("greenhouse", true)], "every amazon board failed (1 of 2 boards failed)"],
    ["no boards", [], null],
  ])("%s", (_n, reports, want) => {
    expect(runFailure(reports as BoardReport[])).toBe(want);
  });
});

// ---- Performance: the added wait of a run with 14 Workday boards, measured on the fake clock ---------------------------------
describe("performance: added wait for 14 Workday boards (budgets fail when exceeded)", () => {
  const WORKDAY = Array.from({ length: 14 }, (_, i) => [`Employer ${i}`, `t${i}`, "wd3", "External"] as [string, string, string, string]);
  const LIST = { total: 1, jobPostings: [{ externalPath: "/job/1", locationsText: "Ireland - Dublin" }] };
  const DETAIL = { jobPostingInfo: { title: "Engineer", location: "Ireland - Dublin", jobDescription: "<p>Work.</p>", externalUrl: "https://example.test/1" } };
  /** Runs every board with `answer` as the server; returns the summed wait, the HTTP calls per Workday tenant, and the reports. */
  async function measure(answer: (url: string, method: string) => Response) {
    const perTenant = new Map<string, number>();
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const tenant = /^https:\/\/([^.]+)\.wd3\./.exec(url)?.[1];
      if (tenant) perTenant.set(tenant, (perTenant.get(tenant) ?? 0) + 1);
      return answer(url, init?.method ?? "GET");
    }) as Fetch;
    const { waits, sleep } = recorder();
    const tasks = atsTasks({ workday: WORKDAY, greenhouse: [["acme", "Acme"]] }, fetch, () => {}, sleep);
    const reports = await runBoards(deps(db, tasks, { sleep }), (x) => plan(x, "reject"));
    const total = waits.reduce((a, b) => a + b, 0);
    return { total, calls: WORKDAY.map(([, t]) => perTenant.get(t) ?? 0), reports };
  }
  const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers });
  const ok = (url: string, method: string) => (url.includes("greenhouse") ? json({ jobs: [] }) : method === "POST" ? json(LIST) : json(DETAIL));

  it("all answer 200: only the pauses, 13 x 1.5 s between boards + 14 x 0.3 s between calls = 23.7 s (budget 25 s)", async () => {
    const { total, calls, reports } = await measure(ok);
    console.log(`W1 perf, all 200: added wait ${total} ms, calls per Workday board ${calls.join(",")}`);
    expect(reports.every((r) => r.ok)).toBe(true);
    expect(total).toBe(13 * PACE.serialBoardGapMs + 14 * PACE.workdayCallGapMs);
    expect(total).toBeLessThanOrEqual(25_000);
    expect(calls).toEqual(Array(14).fill(2));
  });
  it("all answer 429 with no Retry-After: 2 boards x (5 s + 15 s) + one 1.5 s pause = 41.5 s, 3 calls each, then 0 (budget 45 s, 6 calls)", async () => {
    const { total, calls, reports } = await measure((url) => (url.includes("greenhouse") ? json({ jobs: [] }) : json({}, 429)));
    console.log(`W1 perf, all 429: added wait ${total} ms, calls per Workday board ${calls.join(",")}`);
    expect(total).toBe(2 * (5_000 + 15_000) + PACE.serialBoardGapMs);
    expect(total).toBeLessThanOrEqual(45_000);
    expect(calls).toEqual([3, 3, ...Array(12).fill(0)]);
    expect(calls.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(6);
    expect(reports.filter((r) => r.error?.startsWith("skipped after repeated 429"))).toHaveLength(12);
    expect(reports.find((r) => r.kind === "greenhouse")?.ok).toBe(true);
    expect(runFailure(reports)).toMatch(/^every workday board failed/);
  });
  it("worst case, every other board 429 with a hostile Retry-After (the stop never fires): waits stop at the run cap, 180 s + the pauses = 201.6 s (budget 205 s)", async () => {
    const { total, calls } = await measure((url, method) => {
      const t = Number(/^https:\/\/t(\d+)\./.exec(url)?.[1] ?? -1);
      return t >= 0 && t % 2 === 0 ? json({}, 429, { "retry-after": "86400" }) : ok(url, method);
    });
    console.log(`W1 perf, worst case: added wait ${total} ms, calls per Workday board ${calls.join(",")}`);
    const pauses = 13 * PACE.serialBoardGapMs + 7 * PACE.workdayCallGapMs;
    expect(total).toBe(PACE.runWaitMs + pauses);
    expect(total).toBeLessThanOrEqual(205_000);
    // 3 boards get one 60 s wait each (2 calls), the run budget is then spent, the later 429 boards give up on the first call
    expect(calls.filter((_, i) => i % 2 === 0)).toEqual([2, 2, 2, 1, 1, 1, 1]);
  });
});
