// Helpers for the career-site tests: the saved bodies (real samples fetched on 18 Nov 2026; pages trimmed to their JSON-LD, dashes in the advert text made hyphens) and text replies.
import { existsSync, readFileSync } from "node:fs";

export const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const has = (name: string) => existsSync(new URL(`./fixtures/${name}`, import.meta.url));
export const page = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { "content-type": "text/html", ...headers } });

export const PH = {
  mastercard: { employer: "Mastercard", board: "mastercard", origin: "https://careers.mastercard.com", lang: "en_us", country: "us", pageId: "page11", path: "/us/en" },
  thermofisher: { employer: "Thermo Fisher (PPD)", board: "thermofisher", origin: "https://jobs.thermofisher.com", lang: "en_global", country: "global", pageId: "page13", path: "/global/en" },
};
export const SM = {
  citi: { employer: "Citi", board: "citi", origin: "https://jobs.citi.com", sitemap: "/sitemap.xml", pattern: "^https://jobs\\.citi\\.com/job/dublin/[^/]+/287/\\d+$", idFrom: "page" as const },
  fmr: { employer: "Fidelity", board: "fmr", origin: "https://jobs.fidelity.com", sitemap: "/sitemap.xml", pattern: "^https://jobs\\.fidelity\\.com/ie/jobs/(\\d+)/[^/]+/$", idFrom: "url" as const },
  // D1-B, saved 20 Nov 2026: Rezoomo (sitemap trimmed to 8 URLs; pages 105422 Dublin, 105268 Craigavon), two iCIMS sites (whole sitemaps; one page each)
  rezoomo: { employer: "Rezoomo", board: "rezoomo", origin: "https://www.rezoomo.com", sitemap: "/sitemap.xml", pattern: "^https://www\\.rezoomo\\.com/job/(\\d+)/\\?", idFrom: "url" as const, place: "url" as const },
  hsedne: { employer: "HSE Dublin and North East", board: "hsedne", origin: "https://careers-hsedne.icims.com", sitemap: "/sitemap.xml", pattern: "^https://careers-hsedne\\.icims\\.com/jobs/(\\d+)/[^/]+/job$", idFrom: "url" as const, query: "?in_iframe=1" },
  dawnmeats: { employer: "Dawn Meats", board: "dawnmeats", origin: "https://careers-dawnmeats.icims.com", sitemap: "/sitemap.xml", pattern: "^https://careers-dawnmeats\\.icims\\.com/jobs/(\\d+)/[^/]+/job$", idFrom: "url" as const, query: "?in_iframe=1" },
};
export const SF = { slug: "salesforce", employer: "Salesforce (SFDC)" };
export const EF = { employer: "Applied Materials", board: "amat", origin: "https://careers.appliedmaterials.com", domain: "appliedmaterials.com" };
// D1-B, saved 20 Nov 2026: the first search page of each (count set to its 10 jobs) and one detail, which answers every detail call
export const EF_MORE = {
  microsoft: { employer: "Microsoft", board: "microsoft", origin: "https://apply.careers.microsoft.com", domain: "microsoft.com" },
  qualcomm: { employer: "Qualcomm", board: "qualcomm", origin: "https://careers.qualcomm.com", domain: "qualcomm.com" },
};
const EF_HOSTS: Record<string, string> = { "apply.careers.microsoft.com": "microsoft", "careers.qualcomm.com": "qualcomm" };
const ICIMS: Record<string, string> = { "careers-hsedne.icims.com": "hsedne", "careers-dawnmeats.icims.com": "dawnmeats" };
// Eightfold: two saved details; any other listed job gets the first one's text (the adapter reads only jobDescription from it).
const EF_DETAILS = ["790314592423", "790319296162"];

/** Answers every call of the eight sites (and the five D1-B ones) from the fixtures; `over(url, method)` answers first when it returns a Response. 404 otherwise. */
export function sites(over: (url: string, method: string) => Response | undefined = () => undefined) {
  return (c: { url: string; method: string }): Response => {
    const o = over(c.url, c.method);
    if (o) return o;
    const u = new URL(c.url);
    if (c.method === "POST" && u.pathname === "/widgets") return page(read(`phenom-${{ "careers.mastercard.com": "mastercard", "jobs.thermofisher.com": "thermofisher" }[u.host] ?? "none"}-widgets.json`));
    const job = /\/job\/([^/]+)\//.exec(u.pathname)?.[1];
    if (u.host === "careers.mastercard.com" && job === "R-291229") return page(read("phenom-mastercard-R-291229.html"));
    if (u.host === "jobs.thermofisher.com" && has(`phenom-thermofisher-${job}.html`)) return page(read(`phenom-thermofisher-${job}.html`));
    const ef = EF_HOSTS[u.host];
    if (ef) return page(read(`eightfold-${ef}-${u.pathname === "/api/pcsx/search" ? "search-0" : "detail"}.json`));
    const ic = ICIMS[u.host];
    if (ic) {
      if (u.pathname === "/sitemap.xml") return page(read(`icims-${ic}-sitemap.xml`));
      const n = /^\/jobs\/(\d+)\/[^/]+\/job$/.exec(u.pathname)?.[1];
      return u.search === "?in_iframe=1" && has(`icims-${ic}-${n}.html`) ? page(read(`icims-${ic}-${n}.html`)) : page("<html>iCIMS shell, no JSON-LD</html>");
    }
    if (u.host === "www.rezoomo.com") {
      if (u.pathname === "/sitemap.xml") return page(read("rezoomo-sitemap.xml"));
      const n = /^\/job\/(\d+)\/$/.exec(u.pathname)?.[1];
      return page(read(`rezoomo-${n === "105268" ? "105268" : "105422"}.html`)); // any other job gets the Dublin page
    }
    if (u.pathname === "/sitemap.xml") return page(read(u.host === "jobs.citi.com" ? "citi-sitemap.xml" : "fidelity-sitemap.xml"));
    const citi = /\/287\/(\d+)$/.exec(u.pathname)?.[1];
    if (u.host === "jobs.citi.com" && has(`citi-${citi}.html`)) return page(read(`citi-${citi}.html`));
    const fid = /^\/ie\/jobs\/(\d+)\//.exec(u.pathname)?.[1];
    if (u.host === "jobs.fidelity.com" && has(`fidelity-${fid}.html`)) return page(read(`fidelity-${fid}.html`));
    if (u.host === "a.sfdcstatic.com") return page(read("salesforce-jobs_2.json"));
    if (u.host === "careers.appliedmaterials.com" && u.pathname === "/api/pcsx/search") return page(read(`eightfold-amat-search-${u.searchParams.get("start")}.json`));
    const pid = u.searchParams.get("position_id") ?? "";
    if (u.host === "careers.appliedmaterials.com" && u.pathname === "/api/pcsx/position_details") return page(read(`eightfold-amat-${EF_DETAILS.includes(pid) ? pid : EF_DETAILS[0]}.json`));
    return page("not found", 404);
  };
}
