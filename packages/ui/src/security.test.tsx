// Security and accessibility checks on the kit's source and markup.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CandidateShell, CookieBanner } from "./index";
import { Kit } from "./kit";

const dir = new URL(".", import.meta.url).pathname;
const sources = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f)).map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);

describe("brand", () => {
  it("never hard-codes the old name (#289); the name comes from SITE_NAME", () => {
    const old = "Perm" + "itly";
    for (const [f, s] of sources) expect(s, f).not.toContain(old);
    for (const f of ["../../../apps/candidate/app/layout.tsx", "../../../apps/portal/app/layout.tsx", "../../../apps/admin/app/layout.tsx"]) expect(readFileSync(new URL(f, import.meta.url), "utf8")).not.toContain(old);
  });
});

describe("security", () => {
  it("has no dangerouslySetInnerHTML, eval or document.cookie in the kit", () => {
    for (const [f, s] of sources) expect(s, f).not.toMatch(/dangerouslySetInnerHTML|\beval\(|document\.cookie|new Function\(/);
  });
  it("gives every target=_blank link rel noopener noreferrer", () => {
    for (const h of [html(<CandidateShell>x</CandidateShell>), html(<Kit />)]) {
      const blanks = [...h.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]).filter((t) => t.includes('target="_blank"'));
      expect(blanks.length).toBeGreaterThan(0);
      for (const t of blanks) expect(t).toContain('rel="noopener noreferrer"');
    }
  });
  it("labels every input, select and textarea in the kit", () => {
    const h = html(<Kit />);
    const ids = [...h.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(10);
    expect(h.match(/<(?:input|select|textarea)\b/g)!.length).toBe(ids.length);
    for (const id of ids) expect(h).toContain(`for="${id}"`);
  });
  it("the cookie banner sets nothing itself: no script, no cookie, no handler without the page's", () => {
    const h = html(<CookieBanner />);
    expect(h).not.toMatch(/<script|set-cookie|document\.cookie|onclick/i);
  });
  it("hostile text in props is escaped", () => {
    const h = html(<CandidateShell standingLine={'"><img src=x onerror=alert(1)>'} rulesCheckedOn={'<script>1</script>'}>x</CandidateShell>);
    expect(h).not.toContain("<img");
    expect(h).not.toContain("<script>");
  });
  it("the css gives every control a visible focus style", () => {
    expect(readFileSync(join(dir, "tokens.css"), "utf8")).toMatch(/:where\(a, button, input, select, textarea, summary, \[tabindex\]\):focus-visible\s*{\s*outline: 3px/);
    for (const [f, s] of sources) expect(s, f).not.toMatch(/outline-none|focus:outline-0/);
  });
});
