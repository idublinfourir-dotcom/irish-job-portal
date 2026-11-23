// Colour contrast (WCAG AA) for every text and background pair the kit uses, read from tokens.css so a changed value is checked.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const colour = (name: string) => {
  const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`token --color-${name} missing`);
  return m[1]!;
};
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};
const WHITE = "#ffffff";

// [text, background], as used by the components. AA is 4.5 for text of this size.
const PAIRS: [string, string][] = [
  ["ink", "cream"], ["ink", "sand"], ["ink", "peach"], ["ink", "green-tint"], ["ink", "critical-skills"], ["ink", "sponsor"],
  ["muted", "cream"], ["muted", "sand"], ["muted", "white"],
  ["critical-skills-ink", "critical-skills"], ["critical-skills-ink", "green-tint"], ["ink", "lilac"], ["muted", "lilac"], ["deep-green", "cream"], ["deep-green", "white"],
  ["sponsor-ink", "sponsor"],
  ["error", "cream"], ["error", "white"], ["error", "error-tint"],
  ["cream", "ink"], ["white", "deep-green"], ["white", "hover-dark"], ["white", "error"], ["cream", "deep-green"],
  ["ink", "hover-light"], ["ink", "white"], ["disabled-ink", "disabled"],
];

describe("contrast", () => {
  it.each(PAIRS)("%s on %s is at least 4.5", (fg, bg) => {
    const c = (n: string) => (n === "white" ? WHITE : colour(n));
    expect(ratio(c(fg), c(bg))).toBeGreaterThanOrEqual(4.5);
  });
  it("focus ring is at least 3 against the page and white (non-text)", () => {
    for (const bg of [colour("cream"), WHITE, colour("sand")]) expect(ratio(colour("focus"), bg)).toBeGreaterThanOrEqual(3);
  });
  it("keeps the frame's eight colours (NS2; Mint one step darker for AA)", () => {
    const expected = { ink: "#14142b", peach: "#ffc48a", lilac: "#dcd6ff", "deep-green": "#0e8655", sand: "#f6f6fa", line: "#d8d5ee", sponsor: "#e9e5ff", "critical-skills": "#d9f5e7" };
    for (const [k, v] of Object.entries(expected)) expect(colour(k).toLowerCase()).toBe(v);
  });
  it("has a visible focus rule and the two fonts", () => {
    expect(css).toContain(":focus-visible");
    expect(css).toContain("--font-outfit");
    expect(css).toContain("--font-dm-sans");
  });
});
