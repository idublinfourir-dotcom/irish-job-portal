// Unit tests for atsTasks. The network is a fake fetch from the sources testkit; nothing is real.
import { describe, expect, it } from "vitest";
import { FetchFailedError } from "@portal/sources";
import { fake, fixtures, none, reply } from "../../sources/src/ats/testkit";
import { atsTasks, KINDS, kindFilter, type BoardsFile } from "./boards";

// One body that every adapter reads as an empty board.
const EMPTY = { jobs: [], hits: 0, content: [], totalFound: 0, jobPostings: [], total: 0, refineSearch: { totalHits: 0, data: { jobs: [] } }, Report_Entry: [], data: { positions: [], count: 0 } };
const CONFIG: BoardsFile = {
  greenhouse: [["gh-slug", "Gh Ltd"]],
  ashby: [["ash-slug", "Ash Ltd"]],
  smartrecruiters: [["sr-slug", "Sr Ltd"]],
  workday: [["Wd Ltd", "wd-tenant", "wd3", "External"]],
  amazon: true,
  phenom: [["Ph Ltd", "ph-board", "https://careers.ph.example", "en_us", "us", "page11", "/us/en"]],
  sitemap: [["Sm Ltd", "sm-board", "https://jobs.sm.example", "/sitemap.xml", "^https://jobs\\.sm\\.example/ie/(\\d+)/$", "url"]],
  salesforce: [["sf-board", "Sf Ltd"]],
  eightfold: [["Ef Ltd", "ef-board", "https://careers.ef.example", "ef.example"]],
  jobsireland: [["ji-board", 5]],
  lever: [["l1", "L"], ["l2", "L"]],
  workable: [["w1", "W"]],
};

describe("atsTasks", () => {
  it("makes one task per board, in the prototype's order, with the board name the adapters put in advert ids", () => {
    const { fetch } = fake(() => reply(EMPTY));
    expect(atsTasks(CONFIG, fetch).map((t) => [t.kind, t.board])).toEqual([
      ["greenhouse", "gh-slug"], ["ashby", "ash-slug"], ["smartrecruiters", "sr-slug"], ["salesforce", "sf-board"], ["workday", "wd-tenant"], ["phenom", "ph-board"], ["sitemap", "sm-board"], ["eightfold", "ef-board"], ["jobsireland", "ji-board"], ["amazon", "amazon"],
    ]);
  });
  it("each task calls its own adapter with the fetch it was given", async () => {
    const { fetch, calls } = fake((c) => reply(c.url.startsWith("https://jobsireland.ie/") ? { data: [], totalCount: 0 } : EMPTY));
    for (const t of atsTasks(CONFIG, fetch)) expect(await t.fetch(none)).toEqual({ seen: [], adverts: [] });
    expect(calls.map((c) => new URL(c.url).host)).toEqual([
      "boards-api.greenhouse.io", "api.ashbyhq.com", "api.smartrecruiters.com", "a.sfdcstatic.com", "wd-tenant.wd3.myworkdayjobs.com", "careers.ph.example", "jobs.sm.example", "careers.ef.example", "jobsireland.ie", "www.amazon.jobs",
    ]);
  });
  it("passes `known` through: a known advert is seen but not handed over again", async () => {
    const { fetch } = fake(() => reply(fixtures.greenhouse));
    const [task] = atsTasks({ greenhouse: [["acme", "Acme Ltd"]] }, fetch);
    const all = await task!.fetch(none);
    expect(all.adverts.length).toBeGreaterThan(0);
    const again = await task!.fetch(new Set(all.seen));
    expect([again.seen, again.adverts]).toEqual([all.seen, []]);
  });
  it("a failed fetch rejects with FetchFailedError", async () => {
    const { fetch } = fake(() => reply({}, 500));
    const [task] = atsTasks({ ashby: [["a", "A"]] }, fetch);
    await expect(task!.fetch(none)).rejects.toBeInstanceOf(FetchFailedError);
  });
  it("skips kinds with no adapter and logs the count; an empty file gives no tasks", () => {
    const lines: string[] = [];
    const { fetch } = fake(() => reply(EMPTY));
    expect(atsTasks({ lever: [["a", "A"], ["b", "B"]], workable: [["c", "C"]], recruitee: [] }, fetch, (l) => lines.push(l))).toEqual([]);
    expect(lines).toEqual(["skipped 2 lever boards: no adapter", "skipped 1 workable boards: no adapter"]);
    expect(atsTasks({}, fetch)).toEqual([]);
  });
  it("amazon: false makes no task", () => {
    expect(atsTasks({ amazon: false }, fake(() => reply(EMPTY)).fetch)).toEqual([]);
  });
  it("W1c: the new kinds re-read a known advert one day in 7, Salesforce every day (its one call carries the text)", () => {
    expect(Object.fromEntries(atsTasks(CONFIG, fake(() => reply(EMPTY)).fetch).map((t) => [t.kind, t.rereadDays]))).toMatchObject({ phenom: 7, sitemap: 7, eightfold: 7, jobsireland: 7, salesforce: 1, workday: 7 });
  });
  it("the boards file: the 8 career sites under the new kinds (13 with D1-B), and all 14 Workday boards still listed", async () => {
    const { default: file } = await import("../data/boards.json", { with: { type: "json" } });
    const tasks = atsTasks(file as BoardsFile, fake(() => reply(EMPTY)).fetch);
    expect(tasks.filter((t) => ["phenom", "sitemap", "salesforce", "eightfold"].includes(t.kind)).map((t) => `${t.kind}:${t.board}`).sort()).toEqual(
      ["eightfold:amat", "eightfold:microsoft", "eightfold:qualcomm", "phenom:abbott", "phenom:mastercard", "phenom:statestreet", "phenom:thermofisher", "salesforce:salesforce", "sitemap:citi", "sitemap:dawnmeats", "sitemap:fmr", "sitemap:hsedne", "sitemap:rezoomo"]);
    expect(tasks.filter((t) => t.kind === "workday")).toHaveLength(14);
    // every new board's values pass the adapters' own checks (https origin, plain paths, safe names)
    for (const t of tasks.filter((x) => ["phenom", "sitemap", "salesforce", "eightfold"].includes(x.kind))) expect(await t.fetch(none), t.board).toEqual({ seen: [], adverts: [] });
  });
  it("hostile slugs stay inside the adapter's name check and nothing is fetched", async () => {
    const { fetch, calls } = fake(() => reply(EMPTY));
    const [task] = atsTasks({ greenhouse: [["../../evil?x=1", "E"]] }, fetch);
    await expect(task!.fetch(none)).rejects.toBeInstanceOf(FetchFailedError);
    expect(calls).toEqual([]);
  });
});

// W1b: FETCHER_ONLY_KINDS / FETCHER_SKIP_KINDS, the kinds one run fetches (Workday left out on GitHub, the rest on GitHub).
describe("kindFilter", () => {
  const kinds = (only?: string, skip?: string) => atsTasks(CONFIG, fake(() => reply(EMPTY)).fetch).filter((t) => kindFilter(only, skip)(t.kind)).map((t) => t.kind);
  it("knows exactly the kinds atsTasks makes", () => expect([...KINDS].sort()).toEqual([...new Set(kinds())].sort()));
  it("both unset or blank: every kind, as before", () => {
    expect(kinds()).toEqual(["greenhouse", "ashby", "smartrecruiters", "salesforce", "workday", "phenom", "sitemap", "eightfold", "jobsireland", "amazon"]);
    expect(kinds("", " ")).toEqual(kinds());
  });
  it("only: just those kinds; skip: every kind but those (spaces and empty items ignored)", () => {
    expect(kinds("workday")).toEqual(["workday"]);
    expect(kinds(" workday , amazon,")).toEqual(["workday", "amazon"]);
    expect(kinds(undefined, "workday")).toEqual(["greenhouse", "ashby", "smartrecruiters", "salesforce", "phenom", "sitemap", "eightfold", "jobsireland", "amazon"]);
  });
  it("refuses both set, an unknown kind, a kind with no adapter, a wrong case and a list of no kinds", () => {
    expect(() => kindFilter("workday", "workday")).toThrow(/not both/);
    expect(() => kindFilter("workday", "greenhouse")).toThrow(/not both/);
    expect(() => kindFilter("workdy")).toThrow(/unknown board kind in FETCHER_ONLY_KINDS: "workdy"/);
    expect(() => kindFilter(undefined, "workday,lever")).toThrow(/FETCHER_SKIP_KINDS: "lever"/);
    expect(() => kindFilter("Workday")).toThrow(/unknown/);
    expect(() => kindFilter(",")).toThrow(/unknown/);
    expect(() => kindFilter("constructor")).toThrow(/unknown/);
    expect(() => kindFilter("workday'; drop table job;--")).toThrow(/unknown/);
  });
});
