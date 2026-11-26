// Guide cover photos: every cover has a file under 200 KB, alt text and its size; the same slug always gets the same cover; the guide page shows one local cover.
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GuideView } from "./guide-view";
import { COVERS, coverFor } from "./photos";

vi.mock("server-only", () => ({}));

describe("guide covers", () => {
  it("has alt text, a local src and 742 x 420 for each cover", () => {
    for (const c of COVERS) {
      expect(c.alt.length).toBeGreaterThan(10);
      expect(c.src).toMatch(/^\/.*\.webp$/);
      expect([c.width, c.height]).toEqual([742, 420]);
    }
  });
  it("picks the same cover for the same slug", () => {
    expect(coverFor("a-guide")).toBe(coverFor("a-guide"));
    expect(new Set(["a", "bb", "ccc", "dddd", "eeeee", "ffffff"].map((s) => coverFor(s).src)).size).toBeGreaterThan(1);
  });
  it("keeps every cover file under 200 KB (performance budget)", () => {
    const dir = path.join(import.meta.dirname, "photos");
    const files = readdirSync(dir);
    expect(files).toHaveLength(COVERS.length);
    for (const f of files) expect(statSync(path.join(dir, f)).size).toBeLessThan(200 * 1024);
  });
  it("shows one local cover with alt text on a guide page, no outside image", () => {
    const h = html(<GuideView guide={{ slug: "a-guide", title: "A guide", body: "Text", sourceUrl: null, checkedOn: null }} signedIn />);
    const imgs = h.match(/<img[^>]*>/g)!;
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toMatch(/src="\/[^"]*\.webp" width="742" height="420" alt="[^"]{10,}"/);
    expect(h).not.toMatch(/src="https?:|dangerouslySetInnerHTML/);
  });
});
