// Unit: the DETE watcher's pure parts (no database, no network), on the pages saved from DETE's site on 19 Nov 2026 (test/fixtures/dete-watch).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { changeItem, mainPart, MAX_NEW, MAX_TITLE, plain, seen, shortReason, titlesOf, WATCH } from "./dete-watch-cli";

const fx = (f: string) => readFileSync(new URL(`../test/fixtures/dete-watch/${f}`, import.meta.url));
const [latest, csol] = [WATCH[0], WATCH[1]];

describe("plain", () => {
  it("drops scripts, styles and tags, keeps link addresses, decodes entities, removes control characters", () => {
    expect(plain('<p>A &amp; B&nbsp;&#8364;5 &#x41;</p><script>alert(1)</script><style>p{}</style><a href="/x.docx">list</a>\u0000\u0007\u2028z'))
      .toBe("A & B €5 A /x.docx list z");
  });
  it("an entity out of range is a space, an unknown one stays as typed", () => {
    expect(plain("a&#99999999;b &bogus;")).toBe("a b &bogus;");
  });
});

describe("the saved DETE pages", () => {
  it("the latest updates page: main text found, the newest item titles first", () => {
    const main = mainPart(fx("latest-updates.html").toString("utf8"))!;
    expect(main).not.toContain("__VIEWSTATE");
    const t = titlesOf(main);
    expect(t[1]).toBe("2027 Seasonal Employment Permit (SEP) Scheme: Approved Seasonal Employer Application");
    expect(t[2]).toBe("Update on quota for furniture maker and craft woodworker");
  });
  it("the same page with another __VIEWSTATE and elapsed time is the same", () => {
    const html = fx("latest-updates.html").toString("utf8");
    const other = html.replace(/(__VIEWSTATE" value=")[^"]*/, "$1zzz").replace(/Elapsed time: [\d.]+/, "Elapsed time: 9.9");
    expect(other).not.toBe(html);
    expect(seen(latest, Buffer.from(other))).toEqual(seen(latest, Buffer.from(html)));
  });
  it("the CSOL page links its Word file; a moved link is a change", () => {
    const html = fx("csol.html").toString("utf8");
    const a = seen(csol, Buffer.from(html))!;
    const b = seen(csol, Buffer.from(html.replace("critical-skills-occupations-list.docx", "csol-2027.docx")))!;
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(changeItem(csol, a, b)).toMatchObject({ role: "rules_data_editor", name: csol.name, address: csol.address });
  });
  it("a page with no main part, or an empty one, is null (a failed fetch)", () => {
    expect(seen(latest, Buffer.from("<html><body>Service unavailable</body></html>"))).toBeNull();
    expect(seen(latest, Buffer.from('<article class="content-body__sections__main"> <script>x</script> </article>'))).toBeNull();
  });
  it("a Word file is compared by its byte hash only (a new ETag on the same bytes is no change)", () => {
    const doc = WATCH[3], bytes = fx("critical-skills-occupations-list.docx");
    const a = seen(doc, bytes)!;
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(seen(doc, Buffer.from(bytes))).toEqual(a);
    expect(seen(doc, Buffer.concat([bytes, Buffer.from("x")]))!.fingerprint).not.toBe(a.fingerprint);
  });
});

describe("changeItem", () => {
  const s = (fingerprint: string, titles: string[] = []) => ({ fingerprint, titles });
  it("shortReason removes control characters and cuts to 200", () => {
    expect(shortReason(`HTTP 301 to https://x/\u0000\n${"y".repeat(300)}`)).toMatch(/^HTTP 301 to https:\/\/x\/  y{176}$/);
  });
  it("no item for the baseline (none stored, or a row with no value yet after failures) or the same value; one per change, keyed by both values", () => {
    expect(changeItem(latest, undefined, s("a"))).toBeNull();
    expect(changeItem(latest, { fingerprint: null, titles: [] }, s("a"))).toBeNull();
    expect(changeItem(latest, s("a"), s("a"))).toBeNull();
    const i = changeItem(latest, s("a", ["Old"]), s("b", ["New one", "Old"]))!;
    expect(i).toEqual({ key: expect.stringMatching(/^dete_page_changed:latest-updates:[0-9a-f]{16}$/), role: "rules_data_editor", name: latest.name, address: latest.address, newTitles: "New one" });
    expect(changeItem(latest, s("b"), s("a"))!.key).not.toBe(changeItem(latest, s("a"), s("b"))!.key);
  });
  it("hostile titles: each cut by titlesOf, the joined new titles cut to MAX_NEW", () => {
    const huge = `<article class="content-body__sections__main">${Array.from({ length: 50 }, (_, i) => `<h2><script>bad()</script>T${i}${"x".repeat(5000)}\u0001</h2>`).join("")}</article>`;
    const t = titlesOf(huge);
    expect(t.every((x) => x.length === MAX_TITLE && !x.includes("bad") && !/[\u0000-\u001f]/.test(x))).toBe(true);
    expect(changeItem(latest, s("a"), s("b", t))!.newTitles!.length).toBe(MAX_NEW);
  });
});
