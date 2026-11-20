// Helpers for the JobsIreland tests: the saved bodies (real samples fetched on 20 Nov 2026 by the D1 research, step15/d1-boards.md: a list page cut
// to five cards, one detail) and a fake API that pages any list of cards the way the real one does.
import { readFileSync } from "node:fs";
import { reply, type Call } from "../ats/testkit";
import type { Obj } from "../ats/shared";

const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
export const LIST = read("list.json") as { data: Obj[] };
export const DETAIL = read("detail.json") as Obj;
/** A 32 hex id from a number. */
export const hex = (i: number) => i.toString(16).padStart(32, "0");
/** A paid-position card (the saved Pipefitter card) with its id and fields changed. */
export const card = (i: number, over: Obj = {}): Obj => ({ ...LIST.data[1], id: hex(i), ...over });
export const B = { board: "jobsireland", maxDetails: 500, now: () => new Date("2026-11-20T08:00:00Z") };

/** The list API over `cards` (100 a page, `total` as totalCount), and the detail of each id from `detail` (the saved detail by default). */
export function api(cards: Obj[], { total = cards.length, detail = (id: string): Response => reply({ ...DETAIL, id }) }: { total?: number; detail?: (id: string, c: Call) => Response } = {}) {
  return (c: Call): Response => {
    const u = new URL(c.url);
    if (u.host !== "jobsireland.ie") return reply({}, 404);
    if (u.pathname === "/api/jobs") {
      const off = Number(u.searchParams.get("offset"));
      const data = cards.slice(off, off + 100);
      return reply({ limit: 100, offset: off, resultCount: data.length, totalCount: total, data, facets: [] });
    }
    const m = /^\/api\/jobs\/([0-9a-f]{32})$/.exec(u.pathname);
    return m ? detail(m[1]!, c) : reply({}, 404);
  };
}
export const lists = (calls: Call[]) => calls.filter((c) => c.url.includes("/api/jobs?"));
export const details = (calls: Call[]) => calls.filter((c) => /\/api\/jobs\/[0-9a-f]{32}$/.test(c.url));
