// Helpers for the LinkedIn tests: a fake fetch (the ATS one), pages built from made-up text, a fake sleep that records the waits,
// and a seeded random.
import { readFileSync } from "node:fs";
import type { Fetch } from "../types";
import { fake, redirect, type Call } from "../ats/testkit";
import { runLinkedin, type LinkedinInput, type LinkedinPending, type LinkedinResult } from "./index";

export { fake, redirect, type Call };
export const ORIGIN = "https://www.linkedin.com";
export const TODAY = "2026-11-10";
export const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/** A text answer. Response() refuses a status like 999, so that one is a plain object with the same parts the adapter reads. */
export function page(body: string, status = 200, headers: Record<string, string> = {}): Response {
  if (status >= 200 && status <= 599) return new Response(body, { status, headers: { "content-type": "text/html", ...headers } });
  return { status, headers: new Headers(headers), text: async () => body } as unknown as Response;
}

/** A search answer holding these ids, in the shape the real page has (data-entity-urn="urn:li:jobPosting:ID"). */
export const searchPage = (ids: (string | number)[]) => ids.map((id) => `<li><div class="base-card" data-entity-urn="urn:li:jobPosting:${id}">x</div></li>`).join("\n");

export const startOf = (url: string) => Number(new URL(url).searchParams.get("start"));
export const termOf = (url: string) => new URL(url).searchParams.get("keywords");
export const isSearch = (url: string) => url.includes("/seeMoreJobPostings/search");
export const idOf = (url: string) => url.split("/jobPosting/")[1] ?? "";

export function detailPage(o: { title?: string; employer?: string; place?: string; desc?: string; type?: string; salary?: string } = {}): string {
  const { title = "Made Up Title", employer = "Made Up Co", place = "Dublin, Ireland", desc = "Made up text.", type, salary } = o;
  return [
    `<h2 class="top-card-layout__title topcard__title">${title}</h2>`,
    `<a class="topcard__org-name-link topcard__flavor--black-link" href="x">${employer}</a>`,
    `<span class="topcard__flavor topcard__flavor--bullet">${place}</span>`,
    salary ? `<div class="compensation__salary">${salary}</div>` : "",
    `<div class="show-more-less-html__markup relative">${desc}</div>`,
    type ? `<h3 class="description__job-criteria-subheader">Employment type</h3><span class="description__job-criteria-text description__job-criteria-text--criteria">${type}</span>` : "",
  ].join("\n");
}

/** A fake sleep: records the waits and does not wait. */
export function fakeSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

/** mulberry32: the same numbers for the same seed. */
export function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const row = (id: string | number, group = "health", over: Partial<LinkedinPending> = {}): LinkedinPending => ({
  id: String(id), term: "staff nurse", group, firstSeen: "2026-11-01", lastSeen: "2026-11-01", done: false, ...over,
});

/** Runs the adapter with a fake fetch and a fake sleep. `random` is 0 unless given. */
export async function run(handler: (c: Call) => Response | Promise<Response>, waiting: LinkedinPending[] = [], more: Partial<LinkedinInput> = {}) {
  const f = fake(handler);
  const s = fakeSleep();
  const result: LinkedinResult = await runLinkedin({ waiting, today: TODAY, fetch: f.fetch, sleep: s.sleep, random: () => 0, ...more });
  return { result, calls: f.calls, waits: s.waits, urls: f.calls.map((c) => c.url) };
}
export type { Fetch };
