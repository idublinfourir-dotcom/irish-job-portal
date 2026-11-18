// Shared by the fetcher tests. Fake data only; no test calls a real board or a real model.
import type { BatchResult } from "@portal/matcher";
import { CHAIN_RULES_V1 } from "@portal/rules";
import type { Fetch, RawAdvert } from "@portal/sources";
import { sites } from "../../sources/src/careers/testkit";
import type { TestDb } from "../../db/test/db";
import { atsTasks, runBoards, type BoardsFile, type BoardTask, type Db, type Deps, type Plan } from "../src";

export const NOW = new Date("2026-11-10T12:00:00Z");

export const advert = (id: string, over: Partial<RawAdvert> = {}): RawAdvert => ({
  id: `fake:b:${id}`, source: "fake", board: "b", employer: "Acme Ltd", title: "Software Engineer", location: "Dublin, Ireland",
  description: "Build fake things.", url: `https://jobs.example.test/${id}`, employmentType: "", salaryBox: "", ...over,
});

type Kind = "reject" | "passed" | "queued";
/** A plan written by hand, so a test does not depend on what the rules say about an advert. */
export function plan(a: RawAdvert, kind: Kind, over: { employer?: string; salaryLow?: number | null } = {}): Plan {
  const employerName = over.employer ?? a.employer;
  const row = { externalId: a.id, url: a.url, title: a.title, employerName, result: kind === "reject" ? "rejected" : kind, stage: kind === "passed" ? "PASS (salary stated)" : "fake stage", reason: null, quotedEvidence: null, matcherModel: "rules" } as const;
  if (kind === "reject") return { action: "reject", advert: row };
  return {
    action: "job", advert: row, text: a.description,
    job: { title: a.title, employerName, county: "Dublin", sector: "IT", occupationCode: "2134", salaryLow: over.salaryLow === undefined ? 50000 : over.salaryLow, salaryHigh: 60000,
      passRoute: kind === "passed" ? "stated_pay" : null, status: kind === "passed" ? "live" : "in_review", ownPageUrl: a.url },
  };
}

export const task = (kind: string, board: string, adverts: RawAdvert[], seen = adverts.map((a) => a.id)): BoardTask & { calls: ReadonlySet<string>[] } => {
  const calls: ReadonlySet<string>[] = [];
  return { kind, board, calls, fetch: async (known) => { calls.push(new Set(known)); return { seen, adverts: adverts.filter((a) => !known.has(a.id)) }; } };
};

export const matcher: Deps["matcher"] = async () => ({ match: { occupationCode: "2134", onCriticalSkillsList: "yes", confidence: "high" }, quote: null, modelId: "rules", failure: null });
/** A model that is never asked: tests with no badge job. A call fails the test. */
export const noModel: Deps["checkBatch"] = async () => { throw new Error("the model was asked, but no test expected a request"); };
export const deps = (db: Db, boards: BoardTask[], over: Partial<Deps> = {}): Deps => ({
  db, now: () => NOW, chain: { deteNames: new Set(), publicPayCandidates: new Map(), ...CHAIN_RULES_V1 }, matcher, checkBatch: noModel, maxModelRequests: 100, boards, ...over,
});

/** Wraps a Db and records every statement, on the pool and on each checked-out client. */
export function counting(db: Db): { db: Db; sql: string[] } {
  const sql: string[] = [];
  const wrap = (q: Db["query"]) => ((text: string, params?: unknown[]) => (sql.push(text), (q as (...a: unknown[]) => unknown)(text, params))) as Db["query"];
  return {
    sql,
    db: {
      query: wrap(db.query.bind(db)),
      connect: (async () => {
        const c = await db.connect();
        return { query: wrap(c.query.bind(c) as Db["query"]), release: () => c.release() } as unknown as typeof c;
      }) as Db["connect"],
    },
  };
}

/** An advert the rules chain gives a badge: pay stated over the minimum, an Irish place, and the fake rules matcher above says a critical skills occupation. */
export const badgeAd = (id: string, over: Partial<RawAdvert> = {}): RawAdvert =>
  advert(id, { title: "Platform Engineer", description: "Join our team. The salary is €60,000 a year. Permanent full time.", ...over });

export const MODEL = "fake-model";
/** What the model says about one advert: it agrees (a critical skills entry, medium or high confidence) or it does not (no entry). */
export const says = (agrees: boolean): BatchResult => ({
  match: agrees ? { occupationCode: "2134", onCriticalSkillsList: "yes", confidence: "high" } : { occupationCode: "none", onCriticalSkillsList: "unknown", confidence: "none" },
  quote: agrees ? "salary" : null, modelId: MODEL, failure: null,
  entry: agrees ? { id: "cs-1", code: "2134", title: "IT project manager", list: "critical-skills" } : null,
});
/** A fake model client for `Deps.checkBatch`. `reply(n, adverts)` gets the request number (1, 2, ...); a thrown error is a model that fails. Records the size of every request. */
export function fakeModel(reply: (n: number, adverts: { title: string; description: string }[]) => BatchResult[] = (_n, a) => a.map(() => says(true))) {
  const sizes: number[] = [];
  const checkBatch: Deps["checkBatch"] = async (adverts) => {
    sizes.push(adverts.length);
    return reply(sizes.length, adverts);
  };
  return { checkBatch, sizes };
}
/** The model reports a fault for every advert of the request, as `createBatchChecker` does. */
export const fault = (n: number): BatchResult[] => Array.from({ length: n }, () => ({ ...says(false), modelId: MODEL, failure: { kind: "model error" as const, why: "model host answered HTTP 429" } }));

// W1c and W1e: six of the eight career-site boards, answered from the saved bodies (packages/sources/src/careers/fixtures).
export const CAREER_BOARDS: BoardsFile = {
  phenom: [
    ["Mastercard", "mastercard", "https://careers.mastercard.com", "en_us", "us", "page11", "/us/en"],
    ["Thermo Fisher (PPD)", "thermofisher", "https://jobs.thermofisher.com", "en_global", "global", "page13", "/global/en"],
  ],
  sitemap: [
    ["Citi", "citi", "https://jobs.citi.com", "/sitemap.xml", "^https://jobs\\.citi\\.com/job/dublin/[^/]+/287/\\d+$", "page"],
    ["Fidelity", "fmr", "https://jobs.fidelity.com", "/sitemap.xml", "^https://jobs\\.fidelity\\.com/ie/jobs/(\\d+)/[^/]+/$", "url"],
  ],
  salesforce: [["salesforce", "Salesforce (SFDC)"]],
  eightfold: [["Applied Materials", "amat", "https://careers.appliedmaterials.com", "appliedmaterials.com"]],
};
let day = 0;
/** One run of the six boards. `over` answers a call first; every call is recorded. No re-read day, so `known` is every saved id. */
export async function careerRun(d: TestDb, over: (url: string, method: string) => Response | undefined = () => undefined, pool: Db = d.pool("app_fetcher")) {
  const calls: string[] = [];
  const answer = sites(over);
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${String(input)}`);
    return answer({ url: String(input), method });
  }) as Fetch;
  const tasks = atsTasks(CAREER_BOARDS, fetch, () => {}, async () => {}).map((t) => ({ ...t, rereadDays: undefined }));
  const reports = await runBoards(deps(pool, tasks, { checkBatch: fakeModel().checkBatch, now: () => new Date(NOW.getTime() + ++day * 86_400_000) }), (x) => plan(x, "passed"));
  return { reports, calls, by: Object.fromEntries(reports.map((r) => [r.board, r])) };
}
