// The live check (live-check-cli.ts): the page judge on made-up HTML, the crawl on a fake fetch, and the CLI end to end against local
// HTTP servers started here. The real target is the three Vercel sites, which a test may not reach; the servers stand in for them with
// the same kinds of answer (pages, redirects, a 404, a job link, a dropped connection).
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_REQUESTS, PACE_MS, SITES, crawl, judge, main, report, visibleText } from "./live-check-cli.ts";

const html = (body: string, head = "") => `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
const PAGE = "https://www.irishworkpermit.ie/help";

describe("judge", () => {
  it("passes a clean page and returns its same-origin page links only", () => {
    const page = html(
      `<a href="/jobs">Jobs</a><a href="guides?x=1#top">G</a><a href="https://employers.irishworkpermit.ie/">E</a><a href="https://enterprise.gov.ie/">D</a>
       <img src="/_next/static/a.png"><a href="/logo.svg">l</a><script>var s="PLACEHOLDER **x** localhost"</script><!-- coming soon -->
       <style>.a{content:"lorem"}</style><p>Ask us about #permits and 5 * 3.</p>`,
      `<meta name="robots" content="noindex, nofollow"><meta property="og:url" content="https://www.irishworkpermit.ie/help"><link rel="canonical" href="https://www.irishworkpermit.ie/help">`,
    );
    const j = judge(page, PAGE);
    expect(j.fails).toEqual([]);
    expect(j.links.sort()).toEqual(["https://www.irishworkpermit.ie/guides", "https://www.irishworkpermit.ie/help", "https://www.irishworkpermit.ie/jobs"]); // the canonical is an href too
  });

  it("fails each test or local address in href, src, form action and meta content", () => {
    for (const bad of ["http://localhost:3000/x", "https://127.0.0.1/a", "https://example.com", "https://job-portal-x.vercel.app/", "https://a.invalid/",
      "https://staging.irishworkpermit.ie/", "http://www.irishworkpermit.ie/"]) {
      for (const tag of [`<a href="${bad}">x</a>`, `<img src='${bad}'>`, `<form action="${bad}"></form>`, `<meta property="og:image" content="${bad}">`]) {
        expect(judge(html(tag), PAGE).fails, tag).toEqual([expect.stringMatching(/^bad address in (href|src|action|content): /)]);
      }
    }
  });

  it("fails a canonical on another site, a relative one on its own site passes", () => {
    expect(judge(html("", '<link href="https://www.irishworkpermit.ie/" rel="canonical">'), "https://employers.irishworkpermit.ie/").fails)
      .toEqual(["canonical not on https://employers.irishworkpermit.ie: https://www.irishworkpermit.ie/"]);
    expect(judge(html("", '<link rel="canonical" href="/help">'), PAGE).fails).toEqual([]);
  });

  it("fails placeholder words and empty lists in visible text, one line each", () => {
    for (const t of ["PLACEHOLDER TEXT. Do not rely on it.", "Not published yet", "Coming soon", "Lorem ipsum", "No updates here yet"]) {
      expect(judge(html(`<main><h1>Terms</h1><p>${t}</p></main>`), PAGE).fails, t).toEqual([`text: ${t}`]);
    }
  });

  it("fails raw Markdown left in visible text", () => {
    for (const t of ["Read **this** first", "## Who can apply", "See [the list](https://enterprise.gov.ie/)"]) {
      expect(judge(html(`<p>${t}</p>`), PAGE).fails, t).toEqual([`text: ${t}`]);
    }
  });

  it("visible text drops scripts, comments and tags, keeps one line per block, decodes the common entities", () => {
    expect(visibleText(html("<div>A &amp; B</div><p>C<br>D</p><script>x</script><!-- y --><span>E</span>"))).toBe("A & B\nC\nD\nE");
  });
});

// A fake site for the crawl: every page links to the next one and to a job page.
const chain = (status = 200) => {
  const seen: string[] = [];
  const f = (async (url: string | URL | Request) => {
    seen.push(String(url));
    const n = Number(new URL(String(url)).pathname.split("/").at(-1)) || 0;
    return new Response(html(`<a href="/n/${n + 1}">next</a><a href="/jobs/job-${n}">job</a>`), { status, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  return { seen, f };
};
const site = (origin = "https://www.irishworkpermit.ie") => ({ origin, secretFile: "", paths: ["/"] });

describe("crawl limits", () => {
  it("the live run keeps the pace and the cap: 1.1 s between requests, at most 120", () => {
    expect(PACE_MS).toBe(1100);
    expect(MAX_REQUESTS).toBe(120);
    expect(SITES.map((s) => s.origin)).toEqual(["https://www.irishworkpermit.ie", "https://employers.irishworkpermit.ie", "https://admin.irishworkpermit.ie"]);
    expect(SITES.flatMap((s) => s.paths).some((p) => /^\/jobs\/./.test(p))).toBe(false);
  });

  it("stops at the cap, sleeps the pace before every request after the first, and never opens a job page", async () => {
    const { seen, f } = chain();
    const sleeps: number[] = [];
    const r = await crawl([site()], new Map(), { fetch: f, sleep: async (ms) => sleeps.push(ms), cap: 7 });
    expect(seen).toHaveLength(7);
    expect(r.requests).toBe(7);
    expect(sleeps).toEqual(Array(6).fill(1100));
    expect(seen.some((u) => u.includes("/jobs/"))).toBe(false);
    expect(r.jobLinks).toBe(7);
    expect(r.leftOver).toEqual(["https://www.irishworkpermit.ie/n/7"]);
  });

  it("fails an expected 404 that answers 200, a redirect loop, and a bad address in a text body", async () => {
    const f = (async (url: string | URL | Request) => {
      const p = new URL(String(url)).pathname;
      if (p === "/loop") return new Response(null, { status: 302, headers: { location: "/loop" } });
      if (p === "/robots.txt") return new Response("Sitemap: http://localhost:3000/sitemap.xml", { headers: { "content-type": "text/plain" } });
      return new Response(html("<p>ok</p>"), { headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    const r = await crawl([{ ...site(), paths: ["/loop", "/robots.txt"], notFound: ["/kit"] }], new Map(), { fetch: f, sleep: async () => 0 });
    expect(r.pages.map((p) => [new URL(p.url).pathname, p.fails])).toEqual([
      ["/loop", ["too many redirects"]],
      ["/robots.txt", ["bad address: http://localhost:3000/sitemap.xml"]],
      ["/kit", ["expected 404, got 200"]],
    ]);
  });

  it("a job page given as a seed is counted, not opened", async () => {
    const { seen, f } = chain();
    const r = await crawl([{ ...site(), paths: ["/jobs/abc"] }], new Map(), { fetch: f, sleep: async () => 0 });
    expect(seen).toEqual([]);
    expect(r.jobLinks).toBe(1);
  });

  it("main holds a site off loopback to 1.1 s even when asked for less", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "live-check-"));
    writeFileSync(path.join(dir, "s"), "fake-secret-pace\n");
    const { f } = chain();
    const sleeps: number[] = [];
    const env = { LIVE_CHECK_SITES: JSON.stringify([{ ...site(), secretFile: path.join(dir, "s") }]) };
    const lines: string[] = [];
    const code = await main([], env, { fetch: f, sleep: async (ms) => sleeps.push(ms), pace: 0, cap: 3 }, (l) => lines.push(l));
    expect(await main([], env, { fetch: f, sleep: async (ms) => sleeps.push(ms), pace: Number("abc"), cap: 2 }, () => 0)).toBe(0); // NaN too
    rmSync(dir, { recursive: true });
    expect(code).toBe(0);
    expect(sleeps).toEqual([1100, 1100, 1100]);
    expect(lines.join("\n")).not.toContain("fake-secret-pace");
  });

  it("a missing secret file stops the run before any request (exit 2)", async () => {
    const { seen, f } = chain();
    const lines: string[] = [];
    const env = { LIVE_CHECK_SITES: JSON.stringify([{ ...site(), secretFile: "/nonexistent/live-check-secret" }]) };
    expect(await main([], env, { fetch: f, sleep: async () => 0 }, (l) => lines.push(l))).toBe(2);
    expect(seen).toEqual([]);
    expect(lines).toEqual(["cannot read the bypass secret file for https://www.irishworkpermit.ie"]);
  });
});

describe("hostile HTML", () => {
  // Budget: each 2 MB page judged in under 1 s (measured 10 to 340 ms each on the laptop, 26 Nov 2026; the slowest is a million flagged lines), so no pattern backtracks.
  const MB2 = 2 * 1024 * 1024;
  const fill = (s: string) => s.repeat(Math.ceil(MB2 / s.length));
  const pages = {
    "unclosed scripts": fill("<script>"),
    "unclosed comments": fill("<!--"),
    "bare angle brackets": fill("<"),
    "unclosed attributes": fill('<a href="'),
    "one huge attribute": `<a href="${"a".repeat(MB2)}`,
    "huge closed attribute": `<a href="/${"a".repeat(MB2)}">x</a>`,
    "unclosed canonicals": fill('<link rel="canonical" '),
    "deep nesting": fill("<div>"),
    "markdown lines": fill("**#\n"),
  };
  for (const [name, page] of Object.entries(pages)) {
    it(`${name}: judged in under 1 s`, () => {
      const t = performance.now();
      judge(page, PAGE);
      expect(performance.now() - t).toBeLessThan(1000);
    });
  }
});

describe("report", () => {
  it("lists failing pages with reasons, says job markup is not checked, ends with the total", () => {
    const text = report({
      pages: [{ url: "https://x/terms", status: 200, fails: ["text: PLACEHOLDER"], notes: [] }, { url: "https://x/kit", status: 404, fails: [], notes: ["404 as expected"] }],
      requests: 2, jobLinks: 3, leftOver: [],
    });
    expect(text).toContain("- FAIL https://x/terms (200)\n  - text: PLACEHOLDER");
    expect(text).not.toContain("FAIL https://x/kit");
    expect(text).toContain("Job markup (JSON-LD): not checked");
    expect(text).not.toMatch(/JSON-LD\)?: (pass|ok)/i);
    expect(text.trimEnd().split("\n").at(-1)).toBe("Total: 2 pages read in 2 requests, 1 failing, 0 left unread.");
  });
});

describe("the CLI against local servers", () => {
  type Hit = { path: string; secret: string | undefined; at: number };
  const hits = { a: [] as Hit[], b: [] as Hit[], foreign: [] as Hit[] };
  const servers: http.Server[] = [];
  const origins = { a: "", b: "", foreign: "" };
  const dir = mkdtempSync(path.join(tmpdir(), "live-check-cli-"));
  const out = { stdout: "", stderr: "", code: 0, report: "" };
  const SECRET_A = "fake-secret-site-a-4f1c";
  const SECRET_B = "fake-secret-site-b-9e2d";

  const serve = (name: keyof typeof hits, routes: (p: string, res: http.ServerResponse, req: http.IncomingMessage) => void) =>
    new Promise<void>((done) => {
      const s = http.createServer((req, res) => {
        hits[name].push({ path: req.url ?? "", secret: req.headers["x-vercel-protection-bypass"] as string | undefined, at: performance.now() });
        routes(req.url ?? "", res, req);
      });
      servers.push(s);
      s.listen(0, "127.0.0.1", () => { origins[name] = `http://127.0.0.1:${(s.address() as AddressInfo).port}`; done(); });
    });
  const page = (res: http.ServerResponse, body: string, status = 200) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8" }); res.end(html(body)); };

  beforeAll(async () => {
    await serve("foreign", (_p, res) => page(res, "stolen"));
    await serve("b", (_p, res) => page(res, "<p>Site B</p>"));
    await serve("a", (p, res, req) => {
      if (p === "/") return page(res, '<a href="/about">About</a><a href="/jobs/123-nurse">Nurse</a><a href="/jobs/456-chef?x=1">Chef</a><a href="/style.css">s</a>');
      if (p === "/about") return page(res, `<p>About us</p><a href="${origins.foreign}/link">elsewhere</a>`);
      if (p === "/old") { res.writeHead(302, { location: "/about" }); return res.end(); }
      if (p === "/away") { res.writeHead(302, { location: `${origins.foreign}/stolen` }); return res.end(); }
      if (p === "/other") { res.writeHead(308, { location: `${origins.b}/` }); return res.end(); }
      if (p === "/to-job") { res.writeHead(302, { location: "/jobs/789-welder" }); return res.end(); }
      if (p === "/terms") return page(res, "<p>PLACEHOLDER TEXT. Do not rely on it.</p>");
      if (p === "/boom") return req.socket.destroy();
      if (p === "/sitemap-index.xml") { res.writeHead(200, { "content-type": "application/xml" }); return res.end(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://www.irishworkpermit.ie/sitemap/jobs.xml</loc></sitemap></sitemapindex>`); }
      if (p === "/robots.txt") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("User-agent: *\nDisallow: /\n"); }
      return page(res, "<h1>Not found</h1>", 404);
    });
    writeFileSync(path.join(dir, "a"), SECRET_A + "\n");
    writeFileSync(path.join(dir, "b"), SECRET_B);
    const sites = [
      { origin: origins.a, secretFile: path.join(dir, "a"), paths: ["/", "/old", "/away", "/other", "/to-job", "/terms", "/boom", "/missing", "/robots.txt", "/sitemap-index.xml"], notFound: ["/kit"] },
      { origin: origins.b, secretFile: path.join(dir, "b"), paths: ["/"] },
    ];
    const reportFile = path.join(dir, "report.md");
    const cli = path.join(import.meta.dirname, "live-check-cli.ts");
    const env = { ...process.env, LIVE_CHECK_SITES: JSON.stringify(sites), LIVE_CHECK_PACE_MS: "40" };
    try {
      const r = await promisify(execFile)(process.execPath, [cli, reportFile], { env });
      Object.assign(out, { stdout: r.stdout, stderr: r.stderr });
    } catch (e) {
      const err = e as { stdout: string; stderr: string; code: number };
      Object.assign(out, { stdout: err.stdout, stderr: err.stderr, code: err.code });
    }
    out.report = readFileSync(reportFile, "utf8");
  }, 30_000);
  afterAll(() => { for (const s of servers) s.close(); rmSync(dir, { recursive: true }); });

  it("exits 1 and reports each failing page with its reason, and only those", () => {
    expect(out.code).toBe(1);
    const failing = [...out.report.matchAll(/^- FAIL (\S+) \((\d+)\)$/gm)].map((m) => [m[1]!.replace(origins.a, ""), m[2]]);
    expect(failing).toEqual([["/old", "200"], ["/away", "302"], ["/terms", "200"], ["/boom", "0"], ["/missing", "404"]]);
    expect(out.report).toContain(`bad address in href: ${origins.foreign}/link`);
    expect(out.report).toContain(`redirects off our sites to ${origins.foreign} (not followed)`);
    expect(out.report).toContain("text: PLACEHOLDER TEXT. Do not rely on it.");
    expect(out.report).toContain("network error (TypeError)");
    expect(out.report).toContain("status 404");
    expect(out.report).toContain("Job pages seen, not opened (each render writes a view): 3.");
    expect(out.report).not.toContain("sitemap"); // its xmlns is plain http by the standard, not a finding
    expect(out.report).toContain(`  - ${origins.a}/other redirects to ${origins.b}/ (other site, not followed)`);
    expect(out.report).toContain("Expected 404s: 1. Redirects to the other site, not followed: 1.");
    expect(out.stdout.trim()).toBe(out.report.trimEnd().split("\n").at(-1));
    expect(out.stdout.trim()).toMatch(/^Total: 12 pages read in 13 requests, 5 failing, 0 left unread\.$/);
  });

  it("follows a same-origin redirect, never a cross-origin one, and never opens a job page", () => {
    expect(hits.a.map((h) => h.path).sort()).toEqual(["/", "/about", "/away", "/boom", "/kit", "/missing", "/old", "/other", "/robots.txt", "/sitemap-index.xml", "/terms", "/to-job"]);
    expect(hits.a.filter((h) => h.path === "/about")).toHaveLength(1); // /old landed on it and it was not read twice
    expect(hits.foreign).toEqual([]);
    expect(hits.b.map((h) => h.path)).toEqual(["/"]); // its seed only, not through /other's redirect
    expect([...hits.a, ...hits.b].some((h) => h.path.startsWith("/jobs/"))).toBe(false);
  });

  it("sends each site its own secret, and the secrets appear nowhere in stdout, stderr or the report", () => {
    expect(hits.a.every((h) => h.secret === SECRET_A)).toBe(true);
    expect(hits.b.every((h) => h.secret === SECRET_B)).toBe(true);
    for (const text of [out.stdout, out.stderr, out.report]) {
      expect(text).not.toContain(SECRET_A);
      expect(text).not.toContain(SECRET_B);
      expect(text).not.toContain("fake-secret");
    }
  });

  it("keeps the pace between requests (40 ms in this run, 1.1 s live)", () => {
    const times = [...hits.a, ...hits.b, ...hits.foreign].map((h) => h.at).sort((x, y) => x - y);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(35);
  });
});
