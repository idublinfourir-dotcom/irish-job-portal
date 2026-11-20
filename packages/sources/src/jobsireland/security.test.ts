// Security: the JobsIreland adapter against a hostile or broken site. Origin lock, unsafe ids, size caps, wrong types, HTML and script in fields,
// absurd pay and dates, a list that never ends. Everything through the fake fetch; a call to any other host must never happen.
import { describe, expect, it } from "vitest";
import { fake, none, noSleep, redirect, reply } from "../ats/testkit";
import { fetchJobsIreland, JI_MAX_PAGES } from "./jobsireland";
import { api, B, card, DETAIL, details, hex } from "./testkit";

const hosts = (calls: { url: string }[]) => [...new Set(calls.map((c) => new URL(c.url).host))];

describe("origin lock", () => {
  it("a list that redirects to another host fails the board; that host is never called", async () => {
    const { fetch, calls } = fake(() => redirect("https://evil.example/api/jobs"));
    await expect(fetchJobsIreland(B, none, fetch, noSleep)).rejects.toThrow(/refused: request to another host/);
    expect(hosts(calls)).toEqual(["jobsireland.ie"]);
  });
  it("a detail that redirects to another host is skipped (seen, nothing saved); a same-host redirect is followed", async () => {
    const { fetch, calls } = fake(api([card(1), card(2)], { detail: (d) => (d === hex(1) ? redirect("https://evil.example/x") : reply({ ...DETAIL, id: d })) }));
    const r = await fetchJobsIreland(B, none, fetch, noSleep);
    expect(r.seen).toHaveLength(2);
    expect(r.adverts).toHaveLength(1);
    expect(hosts(calls)).toEqual(["jobsireland.ie"]);
  });
  it("an id that is not 32 hex characters fails the board before any detail call", async () => {
    for (const bad of ["../../admin", `${hex(1)}/../x`, "A".repeat(32), "a".repeat(33), "", 7, null]) {
      const { fetch, calls } = fake(api([card(1), card(2, { id: bad })]));
      await expect(fetchJobsIreland(B, none, fetch, noSleep), String(bad)).rejects.toThrow(/unsafe job id|unexpected response shape/);
      expect(details(calls)).toEqual([]);
    }
  });
  it("a bad board name or detail cap fails before any call", async () => {
    for (const b of [{ ...B, board: "../x" }, { ...B, maxDetails: -1 }, { ...B, maxDetails: 1.5 }, { ...B, maxDetails: Number.NaN }]) {
      const { fetch, calls } = fake(api([card(1)]));
      await expect(fetchJobsIreland(b, none, fetch, noSleep)).rejects.toThrow(/unsafe board name|bad detail cap/);
      expect(calls).toEqual([]);
    }
  });
  it("the advert link is built from the id, never taken from the reply", async () => {
    const { fetch } = fake(api([card(1)], { detail: (d) => reply({ ...DETAIL, id: d, url: "https://evil.example", application: { url: "javascript:alert(1)" } }) }));
    expect((await fetchJobsIreland(B, none, fetch, noSleep)).adverts[0]!.url).toBe(`https://jobsireland.ie/search-jobs?jobId=${hex(1)}`);
  });
});

describe("hostile bodies", () => {
  it("a huge count with pages that never end stops after the page cap and fails the board", async () => {
    let n = 0;
    const { fetch, calls } = fake(() => reply({ totalCount: 1e9, data: Array.from({ length: 100 }, () => card(n++)) }));
    await expect(fetchJobsIreland(B, none, fetch, noSleep)).rejects.toThrow(`more than ${JI_MAX_PAGES} pages`);
    expect(calls).toHaveLength(JI_MAX_PAGES);
  });
  it("a Content-Length over 32 MB, or a list that is not JSON, fails the board", async () => {
    await expect(fetchJobsIreland(B, none, fake(() => new Response("{}", { headers: { "content-length": String(64 * 1024 * 1024) } })).fetch, noSleep)).rejects.toThrow(/body too large/);
    await expect(fetchJobsIreland(B, none, fake(() => new Response("<html>Just a moment...</html>")).fetch, noSleep)).rejects.toThrow(/body is not JSON/);
  });
  it("a list of the wrong shape fails the board (nothing closes)", async () => {
    for (const body of [[], { data: {} }, { data: [1], totalCount: 1 }, { data: [card(1)], totalCount: "1" }, { totalCount: 1 }])
      await expect(fetchJobsIreland(B, none, fake(() => reply(body)).fetch, noSleep), JSON.stringify(body)).rejects.toThrow(/unexpected response shape/);
  });
  it("wrong types in a detail give blank fields, never a crash", async () => {
    const odd = { positionTitle: 42, companyName: { x: 1 }, jobDescription: ["a"], location: "Dublin", employmentType: "Full-time", hoursPerWeekText: { a: 1 }, expiration: 20261231, displaySalary: "yes", actualWages: "99999" };
    const { fetch } = fake(api([card(1)], { detail: (d) => reply({ ...odd, id: d }) }));
    const [a] = (await fetchJobsIreland(B, none, fetch, noSleep)).adverts;
    expect(a).toMatchObject({ title: "42", employer: "", location: "Ireland", employmentType: "", salaryBox: "" });
    expect(a!.description).toMatch(/^Posted: 2026-11-\d\d$/);
  });
  it("HTML and script in fields come out as text", async () => {
    const html = { positionTitle: "<b>Chef</b><script>alert(1)</script>", companyName: "Acme &amp; Co <img src=x onerror=alert(1)>", jobDescription: "<p>Cook.</p><script>steal()</script><iframe src=//evil>", hoursPerWeekText: "<i>39</i>" };
    const { fetch } = fake(api([card(1)], { detail: (d) => reply({ ...DETAIL, ...html, id: d }) }));
    const [a] = (await fetchJobsIreland(B, none, fetch, noSleep)).adverts;
    for (const f of [a!.title, a!.employer, a!.description]) expect(f).not.toMatch(/[<>]/);
    expect(a!.employer).toBe("Acme & Co");
    expect(a!.description).toContain("Hours per week: 39");
  });
  it("absurd pay is left out; a description of a million characters is kept for the rules' own length limit to judge", async () => {
    const { fetch } = fake(api([card(1)], { detail: (d) => reply({ ...DETAIL, id: d, displaySalary: true, actualWages: 9e15, jobDescription: "x".repeat(1_000_000) }) }));
    const [a] = (await fetchJobsIreland(B, none, fetch, noSleep)).adverts;
    expect(a!.salaryBox).toBe("");
    expect(a!.description.length).toBeGreaterThan(1_000_000);
  });
  it("a prototype key in the reply changes nothing", async () => {
    const { fetch } = fake(api([card(1)], { detail: () => new Response(`{"__proto__":{"polluted":1},"positionTitle":"Chef","id":"${hex(1)}"}`) }));
    await fetchJobsIreland(B, none, fetch, noSleep);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
