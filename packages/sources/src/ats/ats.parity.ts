// Private parity run for the ATS adapters (brief L3, "Real shapes, fake text"). Two checks over saved REAL response bodies:
//  1. every posting the adapters read becomes a RawAdvert with a non-empty id, title and url, and the counts are printed;
//  2. the adapters' output equals what the Python fetchers returned for the same bodies (ref-outputs.json, made by
//     step5/parity/L3/run_python_ref.py: the Python's own source with `requests` replaced), including the requests made.
// The folder named by PORTAL_PRIVATE_DATA holds L3/raw and L3/ref-outputs.json. If it is not set this FAILS, it never skips.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Fetch, RawAdvert } from "../types";
import { fetchAmazon, fetchAshby, fetchGreenhouse, fetchSmartRecruiters, fetchWorkday } from "./index";

const dir = process.env.PORTAL_PRIVATE_DATA;
if (!dir) throw new Error("PORTAL_PRIVATE_DATA is not set. Set it to the step5/parity folder (the one that holds L3/) to run the private parity test.");
const raw = (n: string) => JSON.parse(readFileSync(`${dir}/L3/raw/${n}`, "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ref = JSON.parse(readFileSync(`${dir}/L3/ref-outputs.json`, "utf8")) as Record<string, { known: string[]; seen: string[]; new: Record<string, string>[]; calls: [string, string, unknown][] }>;

// The same answers as run_python_ref.py gives the Python.
const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
function server(calls: [string, string, unknown][]): Fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push([method, url, init?.body ? JSON.parse(init.body as string) : null]);
    if (url.includes("greenhouse")) return ok(raw("greenhouse-kroll-list.json"));
    if (url.includes("ashbyhq")) return ok(raw("ashby-sitecore-list.json"));
    if (url.includes("smartrecruiters")) {
      if (url.includes("/postings?")) return ok(raw("sr-kingandmoffatt-list0.json"));
      for (const i of [0, 1]) {
        const d = raw(`sr-kingandmoffatt-detail${i}.json`);
        if (url.endsWith("/" + d.id)) return ok(d);
      }
      return ok({}, 404);
    }
    if (url.includes("myworkdayjobs")) {
      const wl = raw("workday-pfizer-list0.json");
      if (method === "POST") return ok(wl);
      for (const i of [0, 1]) if (url.endsWith(wl.jobPostings[i].externalPath)) return ok(raw(`workday-pfizer-detail${i}.json`));
      return ok({}, 404);
    }
    if (url.includes("amazon.jobs")) {
      const off = Number(/offset=(\d+)/.exec(url)?.[1]);
      return ok(off === 0 ? raw("amazon-page0.json") : off === 100 ? raw("amazon-page1.json") : { jobs: [], hits: 224 });
    }
    throw new Error("unrouted " + url);
  }) as Fetch;
}

const camel: Record<string, keyof RawAdvert> = { id: "id", source: "source", board: "board", employer: "employer", title: "title", location: "location", description: "description", url: "url", employment_type: "employmentType", salary_box: "salaryBox" };
const known = (k: string) => new Set(ref[k]!.known);
const runs: Record<string, () => ReturnType<typeof fetchAmazon>> = {};
const calls: Record<string, [string, string, unknown][]> = {};
const mk = (k: string, f: (fe: Fetch) => ReturnType<typeof fetchAmazon>) => {
  calls[k] = [];
  runs[k] = () => {
    calls[k]!.length = 0;
    return f(server(calls[k]!));
  };
};
mk("greenhouse", (f) => fetchGreenhouse({ slug: "krollbondratingagency", employer: "Kroll" }, known("greenhouse"), f));
mk("greenhouse-known", (f) => fetchGreenhouse({ slug: "krollbondratingagency", employer: "Kroll" }, known("greenhouse-known"), f));
mk("ashby", (f) => fetchAshby({ slug: "sitecore", employer: "Sitecore" }, known("ashby"), f));
mk("smartrecruiters", (f) => fetchSmartRecruiters({ slug: "kingandmoffatt", employer: "King" }, known("smartrecruiters"), f));
mk("workday", (f) => fetchWorkday({ employer: "Pfizer", tenant: "pfizer", wd: "wd1", site: "PfizerCareers" }, known("workday"), f));
mk("amazon", (f) => fetchAmazon(undefined, known("amazon"), f));

describe.each(Object.keys(runs))("%s: same as the Python on the saved real bodies", (name) => {
  it("seen ids, new records (every field) and requests are identical", async () => {
    const r = await runs[name]!();
    const want = ref[name]!;
    expect(r.seen).toEqual(want.seen);
    expect(r.adverts.length).toBe(want.new.length);
    let fieldDiffs = 0;
    r.adverts.forEach((a, i) => {
      for (const [k, v] of Object.entries(camel)) if (a[v] !== want.new[i]![k]) fieldDiffs++;
    });
    expect(fieldDiffs).toBe(0);
    expect(calls[name]).toEqual(want.calls);
    console.log(`${name}: ${r.seen.length} seen, ${r.adverts.length} new, ${r.adverts.length * Object.keys(camel).length} fields compared, 0 differences, ${calls[name]!.length} requests`);
  });
  it("every record has a non-empty id, title and url", async () => {
    const r = await runs[name]!();
    for (const a of r.adverts) {
      expect(a.id).not.toBe("");
      expect(a.title).not.toBe("");
      expect(a.url).not.toBe("");
    }
  });
});
