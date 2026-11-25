// P17 part 2 (profile and CV, settings, delete account, goodbye), unit: every answer code of the routes has a plain sentence (read from the contract, not typed
// here), every state of the presentational parts renders to HTML (react-dom/server, no browser, no network, no database), the page titles and descriptions keep
// frame 01's size rules, and no client file imports the auth or database packages. The data layer is stood in.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup as html } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); } }));
vi.mock("../../lib/data", () => ({}));
import { descriptionProblem, titleProblem } from "../../lib/seo";
import { BY_CODE, emailLinkError, sayAccount } from "./settings-messages";
import { DegreeCard, CvCard, MAX_CV_BYTES, STAMPS } from "./profile/profile-form";
import { monthLimits } from "./profile/dates";
import { DataLog } from "./settings/data-log";
import { DeleteForm } from "./settings/settings-forms";
import { ReauthNotice } from "./reauth";
import { Section } from "./section";

const yaml = readFileSync(join(import.meta.dirname, "../../../../docs/openapi/candidate.yaml"), "utf8");
const block = (from: string, to: string) => yaml.slice(yaml.indexOf(from), yaml.indexOf(to, yaml.indexOf(from)));
const shared = (name: string) => new RegExp(`\\n    ${name}:[\\s\\S]*?(?=\\n    [A-Za-z]+:)`).exec(yaml)![0];
const codesIn = (s: string) => [...s.matchAll(/`([A-Z][A-Z_]{3,})`/g)].map((m) => m[1]!);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const clean = (s: string) => expect(s).not.toMatch(/[\u2013\u2014]|undefined|\[object|Better Auth|INVALID_|FORBIDDEN|stack trace|Sample|Launch B|dangerouslySetInnerHTML/);
const cv = { fileName: "fake-cv.pdf", contentType: "pdf", sizeBytes: 182044, uploadedAt: "2026-11-15T14:00:00.000Z" };

describe("every answer code of the routes has its own words", () => {
  it("the codes in the contract of the profile, notifications, export, delete and CV routes, the shared answers they use, and change-password and change-email", () => {
    const mine = [
      block("  /api/candidate/profile:", "  /api/candidate/saved:"), block("  /api/candidate/notifications:", "  /api/candidate/export:"), block("  /api/candidate/export:", "  /api/candidate/alerts:"),
      block("  /api/candidate/cv:", "  /api/candidate/cases:"), ...["BadRequest", "NoSession", "ReadForbidden", "WriteForbidden", "WriteTooMany", "BodyTooLarge", "UploadBadRequest", "FileTooLarge", "WrongFileType", "ActiveContent", "UploadTooMany", "FilesUnavailable"].map(shared), block("- `change-password`", "- `list-accounts`"), block("- `change-email`", "- `link-social`"),
    ].join("\n");
    const codes = [...new Set(codesIn(mine))];
    expect(codes.length).toBeGreaterThan(12);
    expect(sayAccount({ ok: false, status: 403, code: "REAUTH_REQUIRED" }).reauth).toBe(true);
    expect(codes.filter((c) => c !== "REAUTH_REQUIRED" && !BY_CODE[c])).toEqual([]);
  });
  it("every sentence is plain: no code, no dash, no server text; an unknown code gets its status's general line; status 0 means offline", () => {
    for (const [code, t] of Object.entries(BY_CODE)) { clean(t); expect(t, code).toMatch(/[.]$/); expect(t).not.toContain(code); }
    expect(sayAccount({ ok: false, status: 0 }).text).toMatch(/could not reach the site/);
    expect(sayAccount({ ok: false, status: 500, code: "WHATEVER" }).text).toMatch(/went wrong on our side/);
    expect(sayAccount({ ok: false, status: 418, code: "WHATEVER" }).text).toMatch(/did not work/);
    expect(sayAccount({ ok: false, status: 401 }).text).toMatch(/sign-in has ended/);
    expect(sayAccount({ ok: false, status: 429 }).text).toMatch(/Too many/);
    expect(emailLinkError("EMAIL_TAKEN")).toMatch(/has not changed/);
    expect(emailLinkError("INVALID_TOKEN")).toMatch(/did not work/);
  });
  it("the stamps and the file size limit are the contract's", () => {
    const stamps = /currentStamp: \{ enum: \[([^\]]+)\]/.exec(yaml)![1]!.split(",").map((s) => s.trim().replace(/'/g, "")).filter((s) => s !== "null");
    expect([...STAMPS]).toEqual(stamps);
    expect(MAX_CV_BYTES).toBe(4194304);
  });
});

describe("the parts, in every state", () => {
  it("the degree card: three choices, the month picker only for a degree in the last 12 months (DD14), the minimums as read", () => {
    const lim = monthLimits(new Date("2026-11-25T10:00:00Z"));
    expect(lim).toEqual({ min: "2025-11", max: "2026-11" });
    const mins = { criticalSkills: 40904, graduate: 36848, graduateMonths: 12 };
    const recent = html(<DegreeCard box="last_12_months" month="2026-08" field="" mins={mins} limits={lim} />);
    expect(recent).toContain('type="month"'); expect(recent).toContain('min="2025-11"'); expect(recent).toContain('max="2026-11"'); expect(recent).toContain('value="2026-08"');
    expect(text(recent)).toContain("€36,848"); expect(text(recent)).toContain("12 months");
    const old = html(<DegreeCard box="relevant" month="" field="" mins={mins} limits={lim} />);
    expect(old).not.toContain('type="month"'); expect(text(old)).toContain("€40,904");
    const none = html(<DegreeCard box="none" month="" field="" mins={null} limits={lim} />);
    expect(none).not.toContain('name="degreeField"'); expect(none).not.toContain("€");
    for (const h of [recent, old, none]) { clean(h); expect(h.match(/type="radio"/g)).toHaveLength(3); }
  });
  it("the CV card: a CV (download is the route's own address, never a stored link), none, and an error", () => {
    const has = html(<CvCard cv={cv} />);
    expect(has).toContain('href="/api/candidate/cv/download"');
    expect(has).not.toMatch(/https?:\/\//);
    expect(text(has)).toMatch(/fake-cv\.pdf 178 KB · uploaded 15 Nov 2026/);
    expect(text(html(<CvCard cv={null} />))).toContain("No CV yet");
    expect(html(<CvCard cv={null} error={BY_CODE.FILE_TOO_LARGE} />)).toContain("over 4 MB");
    expect(html(<CvCard cv={cv} saved="CV removed." />)).toContain("CV removed.");
    expect(has).toContain(".pdf,.docx");
  });
  it("the who-viewed log (B41): empty at Launch A, and a list with who and when only", () => {
    expect(text(html(<DataLog rows={[]} />))).toContain("No employer or staff member has viewed your data.");
    const h = html(<DataLog rows={[{ by: "Example Care Ltd", action: "contact_request.accept", at: "2026-11-18T09:30:00.000Z" }]} />);
    expect(text(h)).toContain("Example Care Ltd · 18 Nov 2026");
    expect(h).not.toContain("contact_request");
  });
  it("the sign-in-again notice and the delete form: the button waits for the typed word; Keep my account goes back to settings", () => {
    const r = html(<ReauthNotice text={sayAccount({ ok: false, status: 403, code: "REAUTH_REQUIRED" }).text} back="/account/settings/delete" />);
    expect(r).toContain("Sign in again"); clean(r);
    const d = html(<DeleteForm back="/account/settings/delete" googleOnly={false} />);
    expect(d).toMatch(/<button[^>]*disabled[^>]*>Delete account and data|<button[^>]*>Delete account and data/);
    expect(d).toContain('href="/account/settings"'); expect(d).toContain("Type DELETE to confirm"); clean(d);
    expect(html(<Section title="Delete account" tone="danger">x</Section>)).toContain("text-error");
  });
});

describe("pages: titles, descriptions, the stand-in that goes", () => {
  it("each page keeps frame 01's size rules and is noindex", async () => {
    for (const p of ["./profile/page", "./settings/page", "./settings/delete/page", "../account-deleted/page"]) {
      const m = (await import(/* @vite-ignore */ p)).generateMetadata() as { title: string; description: string; robots: unknown };
      const t = m.title.replace(" | Irish Work Permit", "");
      expect(titleProblem(t), p).toBeNull(); expect(descriptionProblem(m.description), p).toBeNull(); expect(m.robots).toEqual({ index: false, follow: false });
      clean(m.title + m.description);
    }
  });
  it("no client file of these pages imports the auth or database packages, and none sets inner HTML", () => {
    const dirs = ["profile", "settings", "settings/delete", "."].map((d) => join(import.meta.dirname, d));
    for (const d of dirs) for (const f of readdirSync(d).filter((x) => /\.(ts|tsx)$/.test(x) && !/test/.test(x))) {
      const s = readFileSync(join(d, f), "utf8");
      if (/^"use client"/.test(s)) expect(s, f).not.toMatch(/@portal\/(auth|db)/);
      expect(s, f).not.toContain("dangerouslySetInnerHTML"); expect(s, f).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
