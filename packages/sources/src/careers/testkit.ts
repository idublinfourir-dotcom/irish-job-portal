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
};
export const SF = { slug: "salesforce", employer: "Salesforce (SFDC)" };

/** Answers every call of the seven sites from the fixtures; `over(url, method)` answers first when it returns a Response. 404 otherwise. */
export function sites(over: (url: string, method: string) => Response | undefined = () => undefined) {
  return (c: { url: string; method: string }): Response => {
    const o = over(c.url, c.method);
    if (o) return o;
    const u = new URL(c.url);
    if (c.method === "POST" && u.pathname === "/widgets") return page(read(`phenom-${{ "careers.mastercard.com": "mastercard", "jobs.thermofisher.com": "thermofisher" }[u.host] ?? "none"}-widgets.json`));
    const job = /\/job\/([^/]+)\//.exec(u.pathname)?.[1];
    if (u.host === "careers.mastercard.com" && job === "R-291229") return page(read("phenom-mastercard-R-291229.html"));
    if (u.host === "jobs.thermofisher.com" && has(`phenom-thermofisher-${job}.html`)) return page(read(`phenom-thermofisher-${job}.html`));
    if (u.pathname === "/sitemap.xml") return page(read(u.host === "jobs.citi.com" ? "citi-sitemap.xml" : "fidelity-sitemap.xml"));
    const citi = /\/287\/(\d+)$/.exec(u.pathname)?.[1];
    if (u.host === "jobs.citi.com" && has(`citi-${citi}.html`)) return page(read(`citi-${citi}.html`));
    const fid = /^\/ie\/jobs\/(\d+)\//.exec(u.pathname)?.[1];
    if (u.host === "jobs.fidelity.com" && has(`fidelity-${fid}.html`)) return page(read(`fidelity-${fid}.html`));
    if (u.host === "a.sfdcstatic.com") return page(read("salesforce-jobs_2.json"));
    return page("not found", 404);
  };
}
