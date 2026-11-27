// Unit tests of the first-visit cover (FM1 flash fix). The inline script runs against faked globals; no DOM package, network or browser.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PRE_SCRIPT, PreCover } from "./pre-cover";

const run = (o: { path?: string; flag?: string | null; webdriver?: boolean; reduce?: boolean; storage?: "throw"; noMatch?: boolean }) => {
  const attrs = new Set<string>();
  const localStorage = { getItem: () => { if (o.storage) throw new Error("blocked"); return o.flag ?? null; } };
  const matchMedia = o.noMatch ? undefined : () => ({ matches: !!o.reduce });
  const document = { documentElement: { setAttribute: (k: string) => attrs.add(k) } };
  new Function("location", "localStorage", "navigator", "matchMedia", "document", PRE_SCRIPT)({ pathname: o.path ?? "/" }, localStorage, { webdriver: !!o.webdriver }, matchMedia, document);
  return attrs.has("data-pre");
};

describe("pre-cover script", () => {
  it("shows the cover only on a first home visit on the device, with motion allowed", () => {
    expect(run({})).toBe(true);
    expect(run({ flag: "1" })).toBe(false);
    expect(run({ path: "/jobs" })).toBe(false);
    expect(run({ webdriver: true })).toBe(false);
    expect(run({ reduce: true })).toBe(false);
  });
  it("fails open: blocked storage or a missing API never throws and never shows the cover", () => {
    expect(run({ storage: "throw" })).toBe(false);
    expect(run({ noMatch: true })).toBe(false);
  });
});

describe("pre-cover HTML", () => {
  it("is hidden by default, aria-hidden, and holds no page text", () => {
    const h = html(<PreCover />);
    expect(h).toMatch(/<div class="mo-cover" hidden="" aria-hidden="true"><\/div>$/);
    expect(h.startsWith(`<script>${PRE_SCRIPT}</script>`)).toBe(true); // raw, not HTML-escaped, so the browser runs it as written
  });
  it("CSS shows it only under html[data-pre] and stops it after 2 s", () => {
    const css = readFileSync(new URL("./motion.css", import.meta.url), "utf8");
    expect(css).toMatch(/html\[data-pre\] \.mo-cover \{[^}]*animation: mo-cover-off 0s 2s forwards/);
    expect(css).not.toMatch(/^\.mo-cover/m);
  });
});

describe("security", () => {
  it("the inline script is a fixed string: no outside origin, cookie, eval, or write to storage", () => {
    expect(PRE_SCRIPT).not.toMatch(/https?:|cookie|eval|setItem|sessionStorage|innerHTML|fetch|\$\{/);
  });
});
