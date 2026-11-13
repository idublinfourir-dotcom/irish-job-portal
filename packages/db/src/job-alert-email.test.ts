// The job alert text builder: pure, no database. Fake people and jobs only.
import { describe, expect, it } from "vitest";
import { socTitle, SOC2010_CODES } from "../../rules/src/soc";
import { salaryLine as searchSalaryLine } from "./search";
import { buildAlertEmail, filtersInWords, parseAlerts, salaryLine, siteOrigin, type AlertRow, type JobRow } from "./job-alert-email";

const SITE = "https://portal.example.ie";
const alert = (o: Partial<AlertRow> = {}): AlertRow => ({ id: "1", candidate_user_id: "c1", occupation_code: null, sector: null, county: null, salary_min: null, badge: null, frequency: "daily", unsubscribe_token: "T".repeat(40), ...o });
const job = (id: string, o: Partial<JobRow> = {}): JobRow => ({ id, title: `Cook ${id}`, employer_name: "Acme", county: "Cork", salary_low: 40000, salary_high: 50000, pay_grade: null, ...o });
const live = (...js: JobRow[]) => new Map(js.map((j) => [j.id, j]));

describe("copies stay in step with the originals", () => {
  it("salaryLine matches search.ts", () => {
    for (const a of [[null, null, null], [1000, 1000, null], [1000, 2500, null], [1000, null, null], [null, 2000, null], [null, null, "Grade III"], [1234567, 2345678, "x"]] as [number | null, number | null, string | null][])
      expect(salaryLine(...a)).toBe(searchSalaryLine(...a));
  });
  it("occupation titles match socTitle for every code", () => {
    const words = (code: string) => filtersInWords(alert({ occupation_code: code }));
    for (const code of SOC2010_CODES) expect(words(code)).toContain(socTitle(code)!.replace(/\s+/g, " ").trim());
  });
});

describe("parseAlerts", () => {
  it("keeps whole-number ids, at most 10 alerts and 20 jobs each, and ignores anything else", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ alert_id: i + 1, job_ids: Array.from({ length: 30 }, (_, k) => k + 1) }));
    const out = parseAlerts({ run_on: "2026-11-13", alerts: many });
    expect(out).toHaveLength(10);
    expect(out[0]!.jobIds).toHaveLength(20);
    expect(parseAlerts({ alerts: [{ alert_id: "1; drop table", job_ids: [1] }, { alert_id: 2, job_ids: [1.5, "x", -3, null, 7] }, { alert_id: 3 }, null, "x"] })).toEqual([{ alertId: "2", jobIds: ["7"] }]);
    for (const bad of [null, undefined, 5, "x", [], {}, { alerts: "x" }, { alerts: {} }]) expect(parseAlerts(bad)).toEqual([]);
  });
});

describe("siteOrigin", () => {
  it("accepts only an https address and drops any path", () => {
    expect(siteOrigin("https://portal.example.ie/")).toBe(SITE);
    expect(siteOrigin("https://portal.example.ie/some/path?x=1")).toBe(SITE);
    for (const bad of [undefined, "", "http://portal.example.ie", "portal.example.ie", "javascript:alert(1)", "https://user:pw@portal.example.ie"]) expect(siteOrigin(bad), String(bad)).toBeNull();
  });
});

describe("filtersInWords", () => {
  it("names every filter in words, with the SOC title", () => {
    const w = filtersInWords(alert({ occupation_code: "2134", sector: "it", county: "Dublin", salary_min: 45000, badge: "sponsor_confirmed", frequency: "weekly" }));
    expect(w).toBe(`occupation ${socTitle("2134")} (2134), sector it, county Dublin, pay from €45,000 a year, only employers with a confirmed sponsor (weekly)`);
    expect(filtersInWords(alert())).toBe("all new jobs (daily)");
  });
});

describe("buildAlertEmail", () => {
  it("builds one block for one alert: the job lines with links, the one-alert link and the all-alerts link and headers", () => {
    const a = alert({ county: "Cork" });
    const m = buildAlertEmail("c1", [{ alertId: "1", jobIds: ["10", "11"] }], new Map([["1", a]]), live(job("10"), job("11", { salary_low: null, salary_high: null, pay_grade: "Grade III" })), SITE)!;
    expect(m.subject).toBe("New jobs matching your job alerts");
    expect(m.text).toContain("PLACEHOLDER WORDING.");
    expect(m.text).toContain("Your alert: county Cork (daily)");
    expect(m.text).toContain(`- Cook 10, Acme, Cork, €40,000 to €50,000\n  ${SITE}/jobs/10`);
    expect(m.text).toContain(`- Cook 11, Acme, Cork, Grade III\n  ${SITE}/jobs/11`);
    expect(m.text).toContain(`Stop this alert: ${SITE}/api/alerts/unsubscribe?token=${"T".repeat(40)}&scope=one`);
    expect(m.text).toContain(`Stop all your job alerts: ${SITE}/api/alerts/unsubscribe?token=${"T".repeat(40)}&scope=all`);
    expect(m.headers).toEqual({ "List-Unsubscribe": `<${SITE}/api/alerts/unsubscribe?token=${"T".repeat(40)}&scope=all>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  });
  it("several alerts: one block each, in the row's order, and the jobs keep the row's order", () => {
    const found = new Map([["1", alert({ id: "1", county: "Cork" })], ["2", alert({ id: "2", sector: "it", unsubscribe_token: "U".repeat(40) })]]);
    const m = buildAlertEmail("c1", [{ alertId: "2", jobIds: ["12", "10"] }, { alertId: "1", jobIds: ["11"] }], found, live(job("10"), job("11"), job("12")), SITE)!;
    expect(m.text.indexOf("sector it")).toBeLessThan(m.text.indexOf("county Cork"));
    expect(m.text.indexOf("jobs/12")).toBeLessThan(m.text.indexOf("jobs/10"));
    expect(m.text.match(/scope=one/g)).toHaveLength(2);
    expect(m.text).toContain(`token=${"U".repeat(40)}&scope=all`); // the all-alerts link uses the first alert shown
  });
  it("leaves out a closed job, an alert with no job left, a missing alert, and another candidate's alert; null when nothing is left", () => {
    const found = new Map([["1", alert({ id: "1" })], ["2", alert({ id: "2", candidate_user_id: "someone-else", unsubscribe_token: "X".repeat(40) })], ["3", alert({ id: "3" })]]);
    const m = buildAlertEmail("c1", [{ alertId: "1", jobIds: ["10", "99"] }, { alertId: "2", jobIds: ["10"] }, { alertId: "3", jobIds: ["99"] }, { alertId: "4", jobIds: ["10"] }], found, live(job("10")), SITE)!;
    expect(m.text).toContain("jobs/10");
    expect(m.text).not.toContain("jobs/99");
    expect(m.text).not.toContain("X".repeat(40));
    expect(m.text.match(/Your alert:/g)).toHaveLength(1);
    expect(buildAlertEmail("c1", [{ alertId: "1", jobIds: ["99"] }], found, live(job("10")), SITE)).toBeNull();
    expect(buildAlertEmail("c9", [{ alertId: "1", jobIds: ["10"] }], found, live(job("10")), SITE)).toBeNull();
  });
  it("hostile job text cannot add lines, headers or links: control and format characters become spaces", () => {
    const evil = job("10", { title: "Cook\r\nBcc: x@y.test\u202e\u200b", employer_name: "Acme\u2028Evil https://evil.example" });
    const m = buildAlertEmail("c1", [{ alertId: "1", jobIds: ["10"] }], new Map([["1", alert()]]), live(evil), SITE)!;
    expect(m.text).toContain("- Cook Bcc: x@y.test, Acme Evil https://evil.example, Cork");
    expect(m.text).not.toMatch(/[\u202e\u200b\u2028\r]/);
    expect(JSON.stringify(m.headers)).not.toMatch(/[\r\n]/);
  });
});
