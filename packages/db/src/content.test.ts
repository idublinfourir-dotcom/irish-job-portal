import { describe, expect, it } from "vitest";
import { BadContentInput, CONTENT_QUERIES, decodeFeedCursor, encodeFeedCursor, getGuide, getPermitNotice, HELP_CATEGORIES, listGuides, listHelp, listUpdates, PERMIT_NOTICE_SLUG, UPDATE_CATEGORIES, UPDATES_PAGE, validSlug } from "./content";

type Call = { text: string; values: unknown[] | undefined };
const fake = (rows: unknown[] = []) => {
  const calls: Call[] = [];
  return { calls, query: (async (text: string, values?: unknown[]) => { calls.push({ text, values }); return { rows }; }) as never };
};

describe("validSlug", () => {
  it.each(["a", "guide-1", "0", "a".repeat(100)])("accepts %s", (s) => expect(validSlug(s)).toBe(true));
  it.each(["", "-a", "A", "a b", "a_b", "a/b", "a\n", "é", "a".repeat(101), "'; drop table content_page; --", 5, null, undefined, ["a"]])("refuses %j", (s) => expect(validSlug(s)).toBe(false));
});

describe("getContent", () => {
  it("never runs a statement for a bad slug", async () => {
    const db = fake();
    expect(await getGuide(db, "Bad Slug")).toBeNull();
    expect(db.calls).toHaveLength(0);
  });
  it("reads the view, not the table, with the kind and slug as parameters", async () => {
    const db = fake();
    await getGuide(db, "work-permits");
    expect(db.calls[0]).toEqual({ text: CONTENT_QUERIES.one, values: ["guide", "work-permits"] });
    for (const q of Object.values(CONTENT_QUERIES)) expect(q).toMatch(/from published_content_page/);
    for (const q of Object.values(CONTENT_QUERIES)) expect(q).not.toMatch(/from content_page/);
  });
});

describe("feed cursor", () => {
  const t = "2027-03-01 00:00:08.123456+00";
  it("round trips", () => expect(decodeFeedCursor(encodeFeedCursor(t, "31"))).toEqual({ t, i: "31" }));
  it.each([
    ["not a string", 5], ["empty", ""], ["not base64url", "a b"], ["too long", "a".repeat(201)], ["not json", "AAAA"],
    ["no fields", Buffer.from("{}").toString("base64url")], ["null", Buffer.from("null").toString("base64url")], ["array", Buffer.from("[]").toString("base64url")],
    ["time not a time", encodeFeedCursor("now", "1")], ["time with SQL", encodeFeedCursor("2027-03-01 00:00:08+00'); drop table job; --", "1")],
    ["month 13", encodeFeedCursor("2027-13-01 00:00:08+00", "1")], ["id with SQL", encodeFeedCursor(t, "1; drop")], ["id zero", encodeFeedCursor(t, "0")],
    ["id over bigint", encodeFeedCursor(t, "9223372036854775808")], ["id a number", Buffer.from(JSON.stringify({ t, i: 1 })).toString("base64url")],
  ])("refuses %s", (_n, token) => expect(() => decodeFeedCursor(token)).toThrow(BadContentInput));
});

describe("listUpdates", () => {
  const row = (n: number) => ({ id: String(n), kind: "update", slug: `s${n}`, title: `t${n}`, body: "b", source_url: null, checked_on: null, published_at: new Date(), updated_at: new Date(), published_text: "2027-03-01 00:00:08.5+00" });
  it("gives a next cursor only when there is a further page, built from the last row shown", async () => {
    const full = fake(Array.from({ length: UPDATES_PAGE + 1 }, (_, i) => row(100 - i)));
    const r = await listUpdates(full);
    expect(r.updates).toHaveLength(UPDATES_PAGE);
    expect(decodeFeedCursor(r.next!)).toEqual({ t: "2027-03-01 00:00:08.5+00", i: String(100 - (UPDATES_PAGE - 1)) });
    expect((await listUpdates(fake([row(1)]))).next).toBeNull();
  });
  it("runs no statement for a bad cursor, and binds the cursor for a good one", async () => {
    const bad = fake();
    await expect(listUpdates(bad, "junk!")).rejects.toThrow(BadContentInput);
    expect(bad.calls).toHaveLength(0);
    const good = fake();
    await listUpdates(good, encodeFeedCursor("2027-03-01 00:00:08+00", "7"));
    expect(good.calls[0]).toEqual({ text: CONTENT_QUERIES.feedAfter, values: ["2027-03-01 00:00:08+00", "7", null] });
  });
  it("orders by the table's own id, not the text output column", () => {
    expect(CONTENT_QUERIES.feedFirst).toContain("published_content_page.id desc");
    expect(CONTENT_QUERIES.feedAfter).toContain("published_content_page.id desc");
  });
});

describe("B15, B17, B19 and #291: the new content reads", () => {
  it("a feed category is one of the four update types, checked before any statement", async () => {
    for (const c of ["", "nope", "QUOTAS", "account", "quotas'; drop table content_page;--", "x".repeat(5000)]) {
      const db = fake();
      await expect(listUpdates(db, undefined, c), c).rejects.toBeInstanceOf(BadContentInput);
      expect(db.calls).toEqual([]);
    }
    for (const c of UPDATE_CATEGORIES) {
      const db = fake();
      await listUpdates(db, undefined, c);
      expect(db.calls.map((x) => x.values)).toEqual([[c]]);
    }
  });
  it("the feed binds the category as the last value (null for all) and keeps the cursor values first", async () => {
    const db = fake();
    await listUpdates(db);
    await listUpdates(db, encodeFeedCursor("2026-11-01 10:00:00+00", "7"), "quotas");
    expect(db.calls.map((x) => x.values)).toEqual([[null], ["2026-11-01 10:00:00+00", "7", "quotas"]]);
    expect(CONTENT_QUERIES.feedFirst).toContain("($1::text is null or category = $1)");
    expect(CONTENT_QUERIES.feedAfter).toContain("($3::text is null or category = $3)");
  });
  it("the update and help groups are the ones the database check holds, and share no word", () => {
    expect([...UPDATE_CATEGORIES]).toEqual(["salary_minimums", "quotas", "occupation_lists", "processing"]);
    expect([...HELP_CATEGORIES]).toEqual(["report_problem", "permit_services", "jobs_badges", "account"]);
    expect(UPDATE_CATEGORIES.filter((c) => (HELP_CATEGORIES as readonly string[]).includes(c))).toEqual([]);
  });
  it("the lists read the published view only, are cut, and give only the fields a list needs", async () => {
    for (const q of [CONTENT_QUERIES.guides, CONTENT_QUERIES.helpPages]) expect(q).toMatch(/from published_content_page where kind = '(guide|help)'.* limit 200$/);
    const g = fake([{ slug: "a", title: "A", checked_on: "2026-11-01", body: "never" }]);
    expect(await listGuides(g)).toEqual({ guides: [{ slug: "a", title: "A", checkedOn: "2026-11-01" }] });
    const h = fake([{ slug: "b", title: "B", category: null }]);
    expect(await listHelp(h)).toEqual({ pages: [{ slug: "b", title: "B", category: null }] });
  });
  it("the permit notice is one fixed slug of the notice kind", async () => {
    const db = fake();
    expect(await getPermitNotice(db)).toBeNull();
    expect(db.calls[0]!.values).toEqual(["notice", PERMIT_NOTICE_SLUG]);
    expect(PERMIT_NOTICE_SLUG).toBe("dete-portal-closed");
  });
});

