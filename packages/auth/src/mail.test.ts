// The account emails (verify, reset, invite) and the shared layout: pure, no network, no database.
import { describe, expect, it } from "vitest";
import { esc, href, render } from "./email-layout";
import { accountEmail } from "./mail";

const BASE = "https://www.example.ie";
const LINK = `${BASE}/api/auth/candidate/verify-email?token=abc.def&callbackURL=/`;
const DASHES = /[\u2013\u2014]/;

describe("accountEmail", () => {
  const cases = [
    ["verify", "Confirm your email address", "1 hour", "Confirm email address"],
    ["reset", "Reset your password", "1 hour and only once", "Choose a new password"],
    ["invite", "You are invited to join a company team on irishworkpermit.ie", "7 days", "Accept the invitation"],
  ] as const;
  for (const [kind, subject, expiry, button] of cases)
    it(`${kind}: subject, what to do, how long the link works, the ignore line, one button and the link written out`, () => {
      const m = accountEmail(kind, LINK, BASE);
      expect(m.subject).toBe(subject);
      for (const part of [m.text, m.html]) {
        expect(part).toContain(expiry);
        expect(part).toMatch(/ignore this email/);
        expect(part).not.toMatch(/PLACEHOLDER|template/i);
        expect(part).not.toMatch(DASHES);
      }
      expect(m.text).toContain(`${button}: ${LINK}`);
      expect(m.html).toContain(`>${button}</a>`);
      expect(m.html.match(new RegExp(`href="${esc(LINK).replace(/[.?]/g, "\\$&")}"`, "g"))).toHaveLength(2); // the button and the fallback link
      expect(m.html).toContain("You got this email because");
      expect(m.html).not.toMatch(/<script|onerror|javascript:/i);
    });
  it("refuses a link on another origin, another scheme or a look-alike host", () => {
    for (const bad of ["https://evil.example/x", "http://www.example.ie/x", "https://www.example.ie.evil.example/x", "https://www.example.ie@evil.example/x"])
      expect(() => accountEmail("reset", bad, BASE), bad).toThrow("not on this site");
    expect(() => accountEmail("reset", "javascript:alert(1)", BASE)).toThrow();
  });
  it("a link with quotes or angle brackets in its query stays inside the href", () => {
    const m = accountEmail("verify", `${BASE}/x?a="><img/src=x/onerror=1>`, BASE);
    expect(m.html).not.toContain("<img");
    expect(m.html).toContain("&quot;&gt;&lt;img");
  });
});

describe("render (the layout)", () => {
  it("escapes every value: heading, paragraphs, footer, button label and subject", () => {
    const evil = `<script>alert(1)</script>"><img src=x onerror=1>&`;
    const m = render(evil, { heading: evil, paragraphs: [evil], footer: evil, button: { label: evil, url: "https://a.example/x" } });
    expect(m.html).not.toMatch(/<script|<img/);
    expect(m.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;&lt;img src=x onerror=1&gt;&amp;");
    expect(m.text).toContain(evil); // plain text is not HTML, nothing to escape
  });
  it("is a table layout at most 560 px wide, with dark mode colours and no remote images or scripts", () => {
    const m = render("s", { heading: "h", paragraphs: ["p"], footer: "f" });
    expect(m.html).toContain('role="presentation"');
    expect(m.html).toContain("max-width:560px");
    expect(m.html).toContain('name="color-scheme" content="light dark"');
    expect(m.html).toContain("prefers-color-scheme: dark");
    expect(m.html).not.toMatch(/<img|<script|src=/);
    expect(m.html).not.toContain("<a "); // no button: no link
  });
  it("href takes only http(s) addresses", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "//evil.example", "https://a.example/x y", ""]) expect(() => href(bad), bad).toThrow("not an http(s)");
    expect(href("https://a.example/x?a=1&b=2")).toBe("https://a.example/x?a=1&amp;b=2");
  });
});
