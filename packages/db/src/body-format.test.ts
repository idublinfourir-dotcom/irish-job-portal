// Unit (no database): the body format of B16 (#303). What `parseBody` makes of each block, what `bodyProblem` refuses before a save, and hostile or huge input.
import { describe, expect, it } from "vitest";
import { allowedHref, bodyProblem, firstParagraph, parseBody, parseInline } from "./body-format";

describe("parseBody", () => {
  it("reads every block of the format, in order", () => {
    const b = parseBody("Intro\nline two\n\n## Pay\n### Pay\n- a\n- **b**\n1. one\n10. ten\n> note\n> more\n| A | B |\n| --- | :---: |\n| 1 | [x](/jobs) |\nafter");
    expect(b.map((x) => x.kind)).toEqual(["p", "h2", "h3", "ul", "ol", "callout", "table", "p"]);
    expect(b[0]).toEqual({ kind: "p", lines: [[{ text: "Intro" }], [{ text: "line two" }]] });
    expect([b[1], b[2]]).toEqual([{ kind: "h2", text: "Pay", id: "pay" }, { kind: "h3", text: "Pay", id: "pay-2" }]);
    expect(b[3]).toEqual({ kind: "ul", items: [[{ text: "a" }], [{ text: "b", bold: true }]] });
    expect(b[6]).toEqual({ kind: "table", head: [[{ text: "A" }], [{ text: "B" }]], rows: [[[{ text: "1" }], [{ text: "x", href: "/jobs" }]]] });
  });
  it("a blank line ends a list or a callout; plain text stays plain; an empty body is no blocks", () => {
    expect(parseBody("- a\n\n- b").filter((x) => x.kind === "ul")).toHaveLength(2);
    expect(parseBody("Plain words, 3 < 4 and 2 * 3 = 6.")).toEqual([{ kind: "p", lines: [[{ text: "Plain words, 3 < 4 and 2 * 3 = 6." }]] }]);
    expect(parseBody(" \n\n \r\n")).toEqual([]);
  });
  it("what breaks a rule is shown as plain text, never as markup", () => {
    expect(parseBody("# Title")).toEqual([{ kind: "p", lines: [[{ text: "# Title" }]] }]);
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ text: "[x](javascript:alert(1))" }]);
    expect(parseInline("[x](http://a.ie) and [y](/jobs)")).toEqual([{ text: "[x](http://a.ie)" }, { text: " and " }, { text: "y", href: "/jobs" }]);
    expect(parseBody("| a |\n| b |")[0]!.kind).toBe("p");
  });
});

describe("allowedHref", () => {
  it.each([["https://enterprise.gov.ie/en/", true], ["/guides/x#y", true], ["/", true], ["http://a.ie", false], ["//evil.example", false], ["javascript:x", false],
    ["https:///x", false], ["data:text/html,x", false], ["mailto:a@b.ie", false], ["guides/x", false],
    // SEC-17: a backslash anywhere, which browsers read as "/" ("/\\evil.example" opens evil.example)
    ["/\\evil.example", false], ["/\\/evil.example", false], ["/\\\\evil.example", false], ["\\\\evil.example", false], ["/x\\y", false], ["/guides/x\\", false],
    ["https://a.ie\\@evil.example", false], ["https:\\\\evil.example", false], ["/%5Cevil.example", false], ["/x%5cy", false], ["/jobs%20list", true]])("%s: %s", (h, ok) => expect(allowedHref(h)).toBe(ok));
  it("a backslash link is shown as its text and refused on save (SEC-17)", () => {
    expect(parseInline("[x](/\\evil.example)")).toEqual([{ text: "[x](/\\evil.example)" }]);
    expect(bodyProblem("see [x](/\\evil.example)")).toBe("link");
  });
});

describe("bodyProblem", () => {
  it.each<[string, string, ReturnType<typeof bodyProblem>]>([
    ["the format", "## A\n\n- b\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n> c [d](https://x.ie)", null],
    ["plain text", "Just words.\nTwo lines, 3 < 4.", null],
    ["a tag", "Hello <b>there</b>", "html"],
    ["a closing tag", "a </p>", "html"],
    ["a comment", "<!-- x -->", "html"],
    ["a script", "<script>alert(1)</script>", "html"],
    ["a heading 1", "Intro\n# Title", "heading_1"],
    ["a javascript link", "[x](javascript:alert(1))", "link"],
    ["a plain http link", "[x](http://a.ie)", "link"],
    ["a relative link", "[x](guides/x)", "link"],
    ["a data link", "[x](data:text/html,<p>)", "html"],
    ["a protocol-relative link", "[x](//evil.example)", "link"],
    ["a table with no rule line", "| a | b |\n| 1 | 2 |", "table"],
    ["a table with a short row", "| a | b |\n| --- | --- |\n| 1 |", "table"],
    ["a one-row table", "| a | b |", "table"],
  ])("%s", (_n, text, want) => expect(bodyProblem(text)).toBe(want));
});

it("firstParagraph skips headings and tables and drops the marks", () => {
  expect(firstParagraph("## H\n\n| a |\n| --- |\n\nIt is **free**, see [jobs](/jobs).")).toBe("It is free, see jobs.");
});

it("performance and hostile input: 50,000 characters of each worst case parse and check in under 200 ms, in time that grows with the length", () => {
  const cases = ["[".repeat(50_000), "[" + "a".repeat(50_000), "[a](" + "x".repeat(50_000), "**".repeat(25_000), "[a](".repeat(12_500), "[a](b".repeat(10_000), "| ".repeat(25_000) + "|", "- ".repeat(25_000), "#".repeat(50_000), "<".repeat(50_000), "a\n".repeat(25_000)];
  for (const c of cases) {
    const t = performance.now();
    parseBody(c);
    bodyProblem(c);
    expect(performance.now() - t, c.slice(0, 8)).toBeLessThan(200);
  }
});
