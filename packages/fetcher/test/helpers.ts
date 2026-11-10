// Shared by the fetcher tests. Fake data only; no test calls a real board or a real model.
import type { RawAdvert } from "@portal/sources";
import type { BoardTask, Db, Deps, Plan } from "../src";

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
export const deps = (db: Db, boards: BoardTask[], over: Partial<Deps> = {}): Deps => ({
  db, now: () => NOW, chain: { deteNames: new Set(), publicPayCandidates: new Map() }, matcher, boards, ...over,
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
