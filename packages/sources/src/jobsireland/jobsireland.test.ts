// Unit and adapter tests of the JobsIreland kind (D1 wave 1): the mapping (pure), the paging, the list-only skips, the detail cap and the 429 path.
// Everything through the fake fetch and the saved bodies; no network.
import { describe, expect, it } from "vitest";
import { fake, none, noSleep, reply } from "../ats/testkit";
import { PACE } from "../ats/shared";
import { fetchJobsIreland, JI_GAP_MS, jiAdvert, jiLocation, jiSalary } from "./jobsireland";
import { api, B, card, DETAIL, details, hex, LIST, lists } from "./testkit";

const TODAY = "2026-11-20";
const id = (i: number) => `jobsireland:jobsireland:${hex(i)}`;

describe("mapping (pure)", () => {
  it("the saved detail maps to the advert every kind produces", () => {
    expect(jiAdvert("jobsireland", "0807d31115dd4490b8dd006b013ae956", DETAIL, TODAY)).toEqual({
      id: "jobsireland:jobsireland:0807d31115dd4490b8dd006b013ae956", source: "jobsireland", board: "jobsireland",
      employer: "Monaghan Group of Parishes Ltd.", title: "Meals on Wheels Driver", location: "Castleblayney, Co. Monaghan, Ireland",
      description: expect.stringMatching(/^Hours per week: 19\.5\nPosted: 2026-11-20\nClosing date: 2026-12-20\n\nYour responsibilities will include ordering/),
      url: "https://jobsireland.ie/search-jobs?jobId=0807d31115dd4490b8dd006b013ae956", employmentType: "Part-time", salaryBox: "",
    });
  });
  it("location: city and county, a card with no county, no location, \"N/A\", another country", () => {
    expect(jiLocation(LIST.data[1]!)).toBe("Mayo, Ireland"); // the saved card's city is "N/A"
    expect(jiLocation({ location: { COUNTRY: "CTY109", CITY: "Ennis" } })).toBe("Ennis, Ireland");
    expect(jiLocation({ location: { COUNTRY: "CTY109", CITY: "Dublin", COUNTY: "Dublin" } })).toBe("Dublin, Ireland");
    expect(jiLocation({})).toBe("Ireland");
    expect(jiLocation({ location: null })).toBe("Ireland");
    expect(jiLocation({ location: { COUNTRY: "CTY22", CITY: "Madrid" } })).toBeNull();
  });
  it("salary: a wage (shown by the site whatever displaySalary says), an hourly wage, bands only when shown, one open band; bad amounts left out", () => {
    const s = (o: object) => jiSalary({ displaySalary: true, ...o });
    expect(jiSalary({ displaySalary: null, actualWages: 36605 })).toBe("€36,605 a year"); // as the real details read on 20 Nov
    const bands = { offeredRemunerationPackages: [{ minimumAmount: 30000, maximumAmount: 39999 }] };
    expect(jiSalary(bands)).toBe(""); // bands the employer chose not to show: the site hides them too
    expect(jiSalary({ displaySalary: false, ...bands })).toBe("");
    expect(s({ actualWages: 40000 })).toBe("€40,000 a year");
    expect(s({ actualWages: 14.5 })).toBe("€29,406 a year"); // hourly, at 39 hours a week, as the salary reader counts it
    expect(s({ offeredRemunerationPackages: [{ minimumAmount: 40000, maximumAmount: 49999 }, { minimumAmount: 30000, maximumAmount: 39999 }] })).toBe("€30,000 to €49,999 a year");
    expect(s({ offeredRemunerationPackages: [{ minimumAmount: 60000, maximumAmount: null }] })).toBe("€60,000 a year");
    expect(s({ offeredRemunerationPackages: [{ minimumAmount: 13.5, maximumAmount: 15 }] })).toBe("€27,378 to €30,420 a year");
    for (const bad of [1e12, -5, 0, Number.NaN, "40000", null, {}, [40000]]) expect(s({ actualWages: bad, offeredRemunerationPackages: [{ minimumAmount: bad }] }), String(bad)).toBe("");
    expect(s({ offeredRemunerationPackages: "€1,000,000" })).toBe("");
  });
  it("closing date: past is not kept, today and later are; an unreadable or absurd date is no date; not active is not kept", () => {
    expect(jiAdvert("b", hex(1), { ...DETAIL, expiration: "2026-11-19" }, TODAY)).toBeNull();
    expect(jiAdvert("b", hex(1), { ...DETAIL, expiration: null, dateClosed: "2025-01-01" }, TODAY)).toBeNull();
    expect(jiAdvert("b", hex(1), { ...DETAIL, expiration: TODAY }, TODAY)).not.toBeNull();
    expect(jiAdvert("b", hex(1), { ...DETAIL, expiration: "2999-12-31" }, TODAY)!.description).toContain("Closing date: 2999-12-31");
    const junk = jiAdvert("b", hex(1), { ...DETAIL, expiration: "yesterday", datePosted: "<b>soon</b>" }, TODAY)!;
    expect(junk.description).not.toMatch(/Closing date|Posted|soon/);
    expect(jiAdvert("b", hex(1), { ...DETAIL, statusCode: "Expired" }, TODAY)).toBeNull();
    expect(jiAdvert("b", hex(1), { ...DETAIL, active: false }, TODAY)).toBeNull();
  });
  it("contract and employment type join", () => {
    expect(jiAdvert("b", hex(1), { ...DETAIL, contractType: { id: "x", name: "Temporary" } }, TODAY)!.employmentType).toBe("Part-time, Temporary");
  });
});

describe("the adapter", () => {
  it("the saved list: welfare scheme places are dropped before any detail read; each paid job is read once, a second apart", async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = fake(api(LIST.data));
    const r = await fetchJobsIreland(B, none, fetch, { sleep: async (ms) => void sleeps.push(ms) });
    expect(r.seen).toHaveLength(3);
    expect(r.adverts.map((a) => a.id)).toEqual(r.seen);
    expect(details(calls)).toHaveLength(3);
    expect(sleeps).toEqual([JI_GAP_MS, JI_GAP_MS, JI_GAP_MS]);
    expect(calls.every((c) => c.method === "GET" && c.redirect === "manual" && c.headers["User-Agent"]?.startsWith("IrishWorkPermitJobs/"))).toBe(true);
  });
  it("paging stops at totalCount, and on an empty page when the total says more", async () => {
    const cards = Array.from({ length: 250 }, (_, i) => card(i));
    const a = fake(api(cards));
    expect((await fetchJobsIreland({ ...B, maxDetails: 0 }, none, a.fetch, noSleep)).seen).toHaveLength(250);
    expect(lists(a.calls).map((c) => new URL(c.url).searchParams.get("offset"))).toEqual(["0", "100", "200"]);
    const b = fake(api(cards.slice(0, 150), { total: 1000 }));
    expect((await fetchJobsIreland({ ...B, maxDetails: 0 }, none, b.fetch, noSleep)).seen).toHaveLength(150);
    expect(lists(b.calls)).toHaveLength(3); // the third page came back empty
  });
  it("a job repeated on the next page is counted and read once", async () => {
    const cards = Array.from({ length: 150 }, (_, i) => card(i === 100 ? 99 : i));
    const { fetch, calls } = fake(api(cards));
    const r = await fetchJobsIreland(B, none, fetch, noSleep);
    expect(r.seen).toHaveLength(149);
    expect(new Set(r.seen).size).toBe(149);
    expect(details(calls)).toHaveLength(149);
  });
  it("a known job costs no detail read; the cap holds and the rest wait, seen, for the next run", async () => {
    const cards = Array.from({ length: 7 }, (_, i) => card(i));
    const one = fake(api(cards));
    const r1 = await fetchJobsIreland({ ...B, maxDetails: 3 }, new Set([id(0)]), one.fetch, noSleep);
    expect(r1.seen).toHaveLength(7); // every listed job is seen: nothing closes for want of a read
    expect(r1.adverts.map((a) => a.id)).toEqual([id(1), id(2), id(3)]);
    expect(details(one.calls)).toHaveLength(3);
    const two = fake(api(cards));
    const r2 = await fetchJobsIreland({ ...B, maxDetails: 3 }, new Set([0, 1, 2, 3].map(id)), two.fetch, noSleep);
    expect(r2.adverts.map((a) => a.id)).toEqual([id(4), id(5), id(6)]);
  });
  it("the list alone decides: another country, not active, dateClosed past: no detail read, not seen", async () => {
    const cards = [card(1, { location: { COUNTRY: "CTY22", CITY: "Madrid" } }), card(2, { active: false }), card(3, { dateClosed: "2026-11-01" }), card(4, { vacancyType: "VTY4" }), card(5)];
    const { fetch, calls } = fake(api(cards));
    const r = await fetchJobsIreland(B, none, fetch, noSleep);
    expect(r.seen).toEqual([id(5)]);
    expect(details(calls).map((c) => c.url)).toEqual([`https://jobsireland.ie/api/jobs/${hex(5)}`]);
  });
  it("a job whose detail is past its closing date is not kept and not seen, so a known one closes", async () => {
    const { fetch } = fake(api([card(1), card(2)], { detail: (d) => reply({ ...DETAIL, id: d, expiration: d === hex(1) ? "2026-11-01" : "2026-12-31" }) }));
    const r = await fetchJobsIreland(B, none, fetch, noSleep);
    expect(r.seen).toEqual([id(2)]);
    expect(r.adverts.map((a) => a.id)).toEqual([id(2)]);
  });
  it("a detail that fails (500, not JSON, not an object) is seen and skipped; the run goes on", async () => {
    const bodies: Record<string, Response | (() => Response)> = { [hex(1)]: () => reply({}, 500), [hex(2)]: () => new Response("<html>", { status: 200 }), [hex(3)]: () => reply([1, 2]) };
    const { fetch } = fake(api([card(1), card(2), card(3), card(4)], { detail: (d) => (bodies[d] ? (bodies[d] as () => Response)() : reply({ ...DETAIL, id: d })) }));
    const r = await fetchJobsIreland(B, none, fetch, noSleep);
    expect(r.seen).toEqual([1, 2, 3, 4].map(id));
    expect(r.adverts.map((a) => a.id)).toEqual([id(4)]);
  });
  it("429 on the list: Retry-After is waited for and the call tried again; without it, the backoff; still refused, the board fails", async () => {
    let n = 0;
    const sleeps: number[] = [];
    const withHeader = fake((c) => (c.url.includes("?") && n++ === 0 ? new Response("", { status: 429, headers: { "retry-after": "7" } }) : api([card(1)])(c)));
    expect((await fetchJobsIreland(B, none, withHeader.fetch, { sleep: async (ms) => void sleeps.push(ms) })).seen).toEqual([id(1)]);
    expect(sleeps[0]).toBe(7000);
    sleeps.length = 0;
    const refused = fake(() => new Response("slow down", { status: 429 }));
    await expect(fetchJobsIreland(B, none, refused.fetch, { sleep: async (ms) => void sleeps.push(ms) })).rejects.toThrow(/^HTTP 429 after 3 tries/);
    expect(sleeps).toEqual(PACE.backoffMs);
  });
  it("429 on a detail after its tries: the detail reads stop for this run, what was read is kept, the rest are seen", async () => {
    const { fetch, calls } = fake(api([card(1), card(2), card(3)], { detail: (d) => (d === hex(2) ? new Response("", { status: 429 }) : reply({ ...DETAIL, id: d })) }));
    const r = await fetchJobsIreland(B, none, fetch, noSleep);
    expect(r.seen).toEqual([1, 2, 3].map(id));
    expect(r.adverts.map((a) => a.id)).toEqual([id(1)]);
    expect(details(calls).filter((c) => c.url.endsWith(hex(3)))).toEqual([]);
  });
  it("5xx on the list fails the board", async () => {
    await expect(fetchJobsIreland(B, none, fake(() => reply({}, 502)).fetch, noSleep)).rejects.toThrow(/^HTTP 502/);
  });
});
