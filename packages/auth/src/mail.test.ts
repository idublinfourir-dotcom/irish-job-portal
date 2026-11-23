// The account emails (verify, reset, invite) and the shared layout: pure, no network, no database.
import { describe, expect, it } from "vitest";
import { C, esc, href, pillHtml, render, SITE_NAME } from "./email-layout";
import { accountEmail } from "./mail";

const BASE = "https://www.example.ie";
const LINK = `${BASE}/api/auth/candidate/verify-email?token=abc.def&callbackURL=/`;
const DASHES = /[\u2013\u2014]/;

describe("accountEmail", () => {
  const cases = [
    ["verify", "Confirm your email address", "1 hour", "Confirm email address"],
    ["reset", "Reset your password", "1 hour and only once", "Choose a new password"],
    ["invite", "You are invited to join a company team on Irish Work Permit", "7 days", "Accept the invitation"],
    ["change-email", "Confirm the change of your email address", "1 hour", "Confirm the change"], // C4, to the old address
    ["new-email", "Confirm your new email address", "1 hour", "Confirm new email address"], // C4, to the new address
  ] as const;
  for (const [kind, subject, expiry, button] of cases)
    it(`${kind}: subject, what to do, how long the link works, the ignore line, one button and no raw link in the HTML`, () => {
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
      expect(m.html.match(new RegExp(`href="${esc(LINK).replace(/[.?]/g, "\\$&")}"`, "g"))).toHaveLength(1); // the button only; the raw link is only in the text version
      expect(m.html).not.toContain(`>${esc(LINK)}<`);
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
  it("uses the Mint Pill tokens: cream page, ink text, deep green pill button, Outfit headings and DM Sans body with system fallbacks (B75)", () => {
    const m = render("s", { heading: "h", paragraphs: ["p"], footer: "f", button: { label: "Go", url: "https://a.example/x" } });
    for (const hex of [C.cream, C.ink, C.green, C.sand]) expect(m.html).toContain(hex);
    expect(m.html).toMatch(/<h1 [^>]*font-family:Outfit,[^>]*sans-serif/);
    expect(m.html).toMatch(/<p [^>]*font-family:'DM Sans',[^>]*sans-serif/);
    expect(m.html).toMatch(/class="btn" style="border-radius:999px;background:#0C4A35"/);
    expect(m.html).not.toMatch(/@font-face|fonts\.googleapis|<link/); // no remote font request
    expect(m.html.match(new RegExp(SITE_NAME, "g"))).toHaveLength(1); // the site name comes from the one constant
    expect(pillHtml("Sponsor", C.sponsor)).toContain("background:#E7E8F5");
    expect(pillHtml("<b>", C.sponsor)).toContain("&lt;b&gt;");
  });
  it("a footer link (settings) shows in the HTML and the text, escaped, and only an http(s) address is allowed", () => {
    const m = render("s", { heading: "h", paragraphs: ["p"], footer: "f", footerLink: { label: "Notification <settings>", url: "https://a.example/account/settings?a=1&b=2" } });
    expect(m.html).toContain('href="https://a.example/account/settings?a=1&amp;b=2"');
    expect(m.html).toContain("Notification &lt;settings&gt;");
    expect(m.text).toContain("Notification <settings>: https://a.example/account/settings?a=1&b=2");
    expect(() => render("s", { heading: "h", paragraphs: [], footer: "f", footerLink: { label: "x", url: "javascript:alert(1)" } })).toThrow("not an http(s)");
    expect(render("s", { heading: "h", paragraphs: [], footer: "f" }).html).not.toContain("<a ");
  });
  it("href takes only http(s) addresses", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "//evil.example", "https://a.example/x y", ""]) expect(() => href(bad), bad).toThrow("not an http(s)");
    expect(href("https://a.example/x?a=1&b=2")).toBe("https://a.example/x?a=1&amp;b=2");
  });
});
