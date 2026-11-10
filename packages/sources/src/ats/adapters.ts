// The five ATS fetchers. Python: prototype/step0/run_day.py:147-282 (f_greenhouse, f_ashby, f_smartrecruiters, f_workday, f_amazon).
// Each takes the fetch function as a parameter, makes the same requests in the same order as the Python (one at a time, no
// retries, no cache), and returns every id seen plus full records only for ids not in `known`.
// Lever, Workable and Recruitee are not ported: no board uses them (PORT-MAP section 3).
import { FetchFailedError, type BoardFetch, type SourceAdapter } from "../types";
import { MAX_PAGES, asArr, asNum, asObj, asStr, at, get, guard, isIrish, job, makeCaller, or, pyStr, safeName, text, type Obj } from "./shared";

export type SlugBoard = { slug: string; employer: string };
export type WorkdayBoard = { employer: string; tenant: string; wd: string; site: string };

const objs = (v: unknown) => asArr(v).map(asObj);

// run_day.py:147-157. One call, no paging. The Irish filter runs on location.name before id and title are read.
export const fetchGreenhouse: SourceAdapter<SlugBoard> = ({ slug, employer }, known, fetch) =>
  guard(slug, async () => {
    safeName(slug, slug);
    const call = makeCaller(slug, fetch, "https://boards-api.greenhouse.io");
    const seen: string[] = [];
    const adverts: BoardFetch["adverts"] = [];
    for (const j of objs(at(asObj(await call(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`)), "jobs"))) {
      const loc = asStr(or(asObj(or(get(j, "location"), {})).name, ""));
      if (!isIrish(loc)) continue;
      const rec = job("greenhouse", slug, at(j, "id"), employer, at(j, "title"), loc, text(get(j, "content")), get(j, "absolute_url"));
      seen.push(rec.id);
      if (!known.has(rec.id)) adverts.push(rec);
    }
    return { seen, adverts };
  });

// run_day.py:177-189. One call; a missing "jobs" key is an empty board (Python `.get("jobs", [])`).
export const fetchAshby: SourceAdapter<SlugBoard> = ({ slug, employer }, known, fetch) =>
  guard(slug, async () => {
    safeName(slug, slug);
    const call = makeCaller(slug, fetch, "https://api.ashbyhq.com");
    const seen: string[] = [];
    const adverts: BoardFetch["adverts"] = [];
    for (const j of objs(get(asObj(await call(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`)), "jobs", []))) {
      const second = asArr(or(get(j, "secondaryLocations"), [])).map((x) => asStr(get(asObj(x), "location", "")));
      const loc = [asStr(or(get(j, "location"), "")), ...second].join(" / ");
      if (!isIrish(loc)) continue;
      const comp = asObj(or(get(j, "compensation"), {}));
      const rec = job("ashby", slug, at(j, "id"), employer, get(j, "title"), loc, get(j, "descriptionPlain"), get(j, "jobUrl"), get(j, "employmentType"), or(get(comp, "compensationTierSummary"), ""));
      seen.push(rec.id);
      if (!known.has(rec.id)) adverts.push(rec);
    }
    return { seen, adverts };
  });

// run_day.py:220-236. The list is already filtered to Ireland by the query (no location filter here). Pages of 100 until
// totalFound; one detail call per posting not in `known`. Any failed call fails the whole board.
export const fetchSmartRecruiters: SourceAdapter<SlugBoard> = ({ slug, employer }, known, fetch) =>
  guard(slug, async () => {
    safeName(slug, slug);
    const base = `https://api.smartrecruiters.com/v1/companies/${slug}`;
    const call = makeCaller(slug, fetch, "https://api.smartrecruiters.com");
    const seen: string[] = [];
    const adverts: BoardFetch["adverts"] = [];
    for (let page = 0, off = 0; ; page++, off += 100) {
      if (page >= MAX_PAGES) throw new FetchFailedError(slug, `more than ${MAX_PAGES} pages`);
      const js = asObj(await call(`${base}/postings?country=ie&limit=100&offset=${off}`));
      const content = objs(get(js, "content", []));
      const total = asNum(get(js, "totalFound", 0));
      for (const p of content) {
        const jid = `smartrecruiters:${slug}:${pyStr(at(p, "id"))}`;
        seen.push(jid);
        if (known.has(jid)) continue;
        const d = asObj(await call(`${base}/postings/${pyStr(at(p, "id"))}`));
        const sec = asObj(get(asObj(get(d, "jobAd", {})), "sections", {}));
        const desc = ["companyDescription", "jobDescription", "qualifications", "additionalInformation"]
          .map((k) => text(get(asObj(get(sec, k, {})), "text")))
          .join("\n");
        const loc = asObj(get(d, "location", {}));
        const etype = get(asObj(or(get(d, "typeOfEmployment"), {})), "label", "");
        adverts.push(job("smartrecruiters", slug, at(p, "id"), employer, get(d, "name"), `${pyStr(get(loc, "city", ""))}, Ireland`, desc, get(d, "postingUrl"), etype));
      }
      // an empty page ends the loop: Python would keep asking up to the total and get nothing more
      if (content.length === 0 || off + 100 >= total) return { seen, adverts };
    }
  });

// run_day.py:239-267. POST list pages of 20 (stop at "total" or once the offset is above 600), then one GET per posting
// not in `known`. A detail call that fails for any reason is skipped and the posting is NOT counted as seen (Python
// `except Exception: continue`): known quirk, see the tests.
export const fetchWorkday: SourceAdapter<WorkdayBoard> = ({ employer, tenant, wd, site }, known, fetch) =>
  guard(tenant, async () => {
    safeName(tenant, tenant, wd, site);
    const origin = `https://${tenant}.${wd}.myworkdayjobs.com`;
    const base = `${origin}/wday/cxs/${tenant}/${site}`;
    const call = makeCaller(tenant, fetch, origin);
    const posts: Obj[] = [];
    for (let off = 0; ; ) {
      const js = asObj(await call(`${base}/jobs`, { appliedFacets: {}, limit: 20, offset: off, searchText: "Ireland" }));
      posts.push(...objs(get(js, "jobPostings", [])));
      off += 20;
      if (off >= asNum(get(js, "total", 0)) || off > 600) break;
    }
    const seen: string[] = [];
    const adverts: BoardFetch["adverts"] = [];
    for (const p of posts) {
      const path = get(p, "externalPath");
      if (!path) continue;
      const jid = `workday:${tenant}:${pyStr(path)}`;
      if (known.has(jid)) {
        seen.push(jid);
        continue;
      }
      let d: Obj;
      try {
        d = asObj(at(asObj(await call(base + asStr(path))), "jobPostingInfo"));
      } catch {
        continue;
      }
      const loc = [asStr(get(d, "location", "")), ...asArr(get(d, "additionalLocations", [])).map(asStr)].join(" / ");
      if (!isIrish(loc)) continue;
      seen.push(jid);
      adverts.push(job("workday", tenant, path, employer, get(d, "title"), loc, text(get(d, "jobDescription")), get(d, "externalUrl"), get(d, "timeType", "")));
    }
    return { seen, adverts };
  });

// run_day.py:270-282. Pages of 100 until "hits". No board name: there is one Amazon board. No location filter (the query is Ireland).
export const fetchAmazon: SourceAdapter<undefined> = (_board, known, fetch) =>
  guard("amazon", async () => {
    const call = makeCaller("amazon", fetch, "https://www.amazon.jobs");
    const seen: string[] = [];
    const adverts: BoardFetch["adverts"] = [];
    for (let page = 0, off = 0; ; page++, off += 100) {
      if (page >= MAX_PAGES) throw new FetchFailedError("amazon", `more than ${MAX_PAGES} pages`);
      const js = asObj(await call(`https://www.amazon.jobs/en/search.json?loc_query=Ireland&country=IRL&result_limit=100&offset=${off}`));
      const jobs = objs(at(js, "jobs"));
      for (const j of jobs) {
        const desc = ["description", "basic_qualifications", "preferred_qualifications"].map((k) => text(get(j, k))).join("\n");
        const rec = job(
          "amazon",
          "amazon",
          or(get(j, "id_icims"), get(j, "job_path")),
          "Amazon",
          get(j, "title"),
          or(get(j, "normalized_location"), get(j, "location", "")),
          desc,
          "https://www.amazon.jobs" + asStr(get(j, "job_path", "")),
          get(j, "job_schedule_type", ""),
        );
        seen.push(rec.id);
        if (!known.has(rec.id)) adverts.push(rec);
      }
      const hits = asNum(at(js, "hits"));
      if (jobs.length === 0 || off + 100 >= hits) return { seen, adverts };
    }
  });
