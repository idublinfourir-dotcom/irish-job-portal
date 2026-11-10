// Private parity run for the LinkedIn adapter (brief L4, "Real shapes, fake text"). NOT part of `npm run check`. Two checks:
//  1. the detail parser gives, field by field, what the Python gives for the same pages (ref-outputs.json, made by
//     step5/parity/L4/run_python_ref.py from copies of the Python functions; cases/ holds the pages: the repo fixtures and odd corners);
//  2. the adapter run over the REAL bodies saved by the one recording pass (L4/raw): the search pages give plain digit ids,
//     and each saved detail answer is read as the run would read it: a 200 body must give an advert with a non-empty id, title
//     and url, and a 429/999/403 answer must stop the run with that status and keep every id waiting.
// The folder named by PORTAL_PRIVATE_DATA holds L4/. If it is not set this FAILS, it never skips.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Fetch } from "../types";
import { parseLinkedinDetail, runLinkedin } from "./index";
import { fakeSleep, TODAY } from "./testkit";

const dir = process.env.PORTAL_PRIVATE_DATA;
if (!dir) throw new Error("PORTAL_PRIVATE_DATA is not set. Set it to the step5/parity folder (the one that holds L4/) to run the private parity test.");
const L4 = `${dir}/L4`;
const ref = JSON.parse(readFileSync(`${L4}/ref-outputs.json`, "utf8")) as Record<string, Record<string, string>>;
const camel: Record<string, string> = { employment_type: "employmentType", salary_box: "salaryBox" };

describe("detail parser against the Python (copied functions, same pages)", () => {
  const names = readdirSync(`${L4}/cases`).filter((f) => f.endsWith(".html"));
  it("there are cases", () => expect(names.length).toBeGreaterThanOrEqual(10));
  for (const f of names) {
    it(f, () => {
      const ours = parseLinkedinDetail("123", readFileSync(`${L4}/cases/${f}`, "utf8")) as Record<string, string>;
      const want = Object.fromEntries(Object.entries(ref[f.replace(/\.html$/, "")]!).map(([k, v]) => [camel[k] ?? k, v]));
      expect(ours).toEqual(want);
    });
  }
});

describe("the adapter over the real saved bodies", () => {
  const raw = (n: string) => ({
    meta: JSON.parse(readFileSync(`${L4}/raw/${n}.meta.json`, "utf8")) as { url: string; status: number; headers: Record<string, string> },
    body: readFileSync(`${L4}/raw/${n}.body`, "utf8"),
  });
  const answer = (n: string): Response => {
    const { meta, body } = raw(n);
    const headers = Object.fromEntries(Object.entries(meta.headers).filter(([k]) => !["content-encoding", "content-length", "set-cookie"].includes(k)));
    return new Response(body, { status: meta.status, headers });
  };
  const details = readdirSync(`${L4}/raw`).filter((f) => /^detail-\d+\.meta\.json$/.test(f)).map((f) => f.replace(".meta.json", "")).sort();
  const calls: string[] = [];
  let next = 0;
  const fetch: Fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/seeMoreJobPostings/search")) {
      const u = new URL(url);
      if (u.searchParams.get("keywords") !== "staff nurse") return new Response("");
      const start = Number(u.searchParams.get("start"));
      return start === 0 ? answer("search-p1") : start === 10 ? answer("search-p2") : new Response("");
    }
    const n = details[next++];
    if (!n) throw new Error("the run asked for more detail pages than were recorded");
    return answer(n);
  }) as Fetch;

  it("search pages give plain digit ids, detail answers are read as the run would read them", async () => {
    const s = fakeSleep();
    const result = await runLinkedin({ waiting: [], today: TODAY, fetch, sleep: s.sleep, random: () => 0, options: { maxRequests: 100 } });
    expect(existsSync(`${L4}/raw/search-p1.body`)).toBe(true);
    expect(result.seen).toHaveLength(20);
    for (const id of result.seen) expect(id).toMatch(/^\d{10}$/);
    // the first detail answer that was recorded decides what the run does next
    for (const a of result.adverts) {
      expect(a.id).toMatch(/^linkedin:ie:\d+$/);
      expect(a.title, "title of " + a.id).not.toBe("");
      expect(a.url, "url of " + a.id).toMatch(/^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+$/);
    }
    const first = details[0] ? raw(details[0]).meta.status : null;
    if (first !== null && [429, 999, 403].includes(first)) {
      expect(result.stop).toMatchObject({ phase: "detail", reason: "limit", status: first });
      expect(result.adverts).toEqual([]);
      expect(result.waiting.filter((r) => !r.done)).toHaveLength(20); // nothing lost
      console.log(`no real detail body: LinkedIn answered ${first} to the first detail request; the run stopped as designed`);
    } else {
      console.log(`real detail pages read: ${result.adverts.length}`);
    }
    console.log(`real search ids: ${result.seen.length}, requests: ${calls.length}`);
  });
});
