// Employer hero photo: alt text, size and a file under 200 KB (performance budget).
import { statSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { EMPLOYER_HERO } from "./photos";

it("has a local src, alt text, 1000 x 940 and a file under 200 KB", () => {
  expect(EMPLOYER_HERO.src).toMatch(/^\/.*\.webp$/);
  expect(EMPLOYER_HERO.alt.length).toBeGreaterThan(10);
  expect([EMPLOYER_HERO.width, EMPLOYER_HERO.height]).toEqual([1000, 940]);
  expect(statSync(path.join(import.meta.dirname, "photos", "employer-hero.webp")).size).toBeLessThan(200 * 1024);
});
