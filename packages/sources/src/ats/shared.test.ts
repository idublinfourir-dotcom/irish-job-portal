import { describe, expect, it } from "vitest";
import golden from "./fixtures/text-golden.json";
import { htmlUnescape, isIrish, pyStrip, text } from "./shared";

// text-golden.json: made-up fuzz strings (tags, entities, odd whitespace, odd Unicode) and what the Python
// (fetch_ats.py text() and IRL.search) answered for each, made by step5/parity/L3/make_text_golden.py.
describe("text() and the Irish filter against the Python", () => {
  it("gives the Python's answer for every fuzz string", () => {
    const bad = (golden.text as [string, string][]).filter(([input, want]) => text(input) !== want);
    expect(bad.length).toBe(0);
    expect(golden.text.length).toBe(1500);
  });
  it("gives the Python's yes or no for every fuzz location", () => {
    const bad = (golden.irl as [string, boolean][]).filter(([input, want]) => isIrish(input) !== want);
    expect(bad.length).toBe(0);
  });
});

describe("text()", () => {
  it("turns break tags into newlines and drops other tags", () => {
    expect(text("<p>One</p><p>Two<br>Three</p><ul><li>A</li><li>B</li></ul><h2>Head</h2>tail<div>x</div>")).toBe("One\n Two\nThree\n A\n B\n Head\ntail x");
  });
  it("decodes escaped HTML (the Greenhouse kind) once, then strips tags (a double-escaped & stays escaped)", () => {
    expect(text("&lt;p&gt;Fish &amp;amp; chips&lt;/p&gt;&lt;p&gt;It&#39;s&nbsp;fine&lt;/p&gt;")).toBe("Fish &amp; chips\n It's\u00a0fine");
  });
  it("handles null, undefined and empty", () => {
    expect([text(null), text(undefined), text("")]).toEqual(["", "", ""]);
  });
  it("leaves unknown entities and bare ampersands (R&D) alone, as Python does", () => {
    expect(text("R&D and &nonsense; &D")).toBe("R&D and &nonsense; &D");
  });
  it("known quirk: a legacy entity with no semicolon is decoded inside a word", () => {
    expect(text("&notable")).toBe("¬able");
  });
  it("known quirk: a tag-like run in plain text is dropped", () => {
    expect(text("a < b and c > d")).toBe("a d");
  });
  it("collapses blank lines and runs of spaces and tabs", () => {
    expect(text("a \t  b\n \n\n c")).toBe("a b\n c");
  });
  it("refuses a value that is not text (Python raises, the board fails)", () => {
    expect(() => text(5)).toThrow();
  });
});

describe("Python whitespace", () => {
  it("strips what Python strips and keeps the byte order mark", () => {
    expect(pyStrip("\x1c\x85　 hi  \n")).toBe("hi");
    expect(pyStrip("﻿hi")).toBe("﻿hi");
  });
  it("stays fast on a long run of white space inside the text (untrusted titles and descriptions)", () => {
    const hostile = `a${" ".repeat(80_000)}b`;
    const t0 = performance.now();
    expect(pyStrip(hostile)).toBe(hostile);
    expect(pyStrip(`${" ".repeat(80_000)}a${"\t".repeat(80_000)}`)).toBe("a");
    expect(performance.now() - t0).toBeLessThan(200); // measured under 5 ms; the old regular expression took 4.8 s
  });
});

describe("htmlUnescape", () => {
  it("handles numeric edge cases like Python", () => {
    expect(htmlUnescape("&#128;&#xD800;&#1114112;&#0;&#x41;&#65")).toBe("€���AA");
  });
  it("does not treat object property names as entities", () => {
    expect(htmlUnescape("&constructor; &__proto__;")).toBe("&constructor; &__proto__;");
  });
});

describe("isIrish", () => {
  it("matches whole words only, any case", () => {
    expect([isIrish("Dublin, Ireland"), isIrish("CORK"), isIrish("Corkscrew"), isIrish("Ennis-West"), isIrish("Cafédublin"), isIrish("New York")]).toEqual([true, true, false, true, false, false]);
  });
});
