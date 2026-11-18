import { describe, expect, it } from "vitest";
import { blocking } from "./audit-gate-cli";

const adv = (id: string, severity: string) => ({ url: `https://github.com/advisories/${id}`, severity, title: `t ${id}` });

describe("audit gate", () => {
  it("passes when the only high advisory is an ignored one, also when other packages reach it by name", () => {
    const r = { vulnerabilities: { picomatch: { via: [adv("GHSA-fc5q-39xc-vjpf", "high")] }, vitest: { via: ["picomatch", "vite"] } } };
    expect(blocking(r)).toEqual([]);
  });
  it("fails on any other high or critical advisory, once each, and ignores moderate and low", () => {
    const r = {
      vulnerabilities: {
        a: { via: [adv("GHSA-aaaa-bbbb-cccc", "high"), adv("GHSA-dddd-eeee-ffff", "moderate")] },
        b: { via: [adv("GHSA-aaaa-bbbb-cccc", "high"), adv("GHSA-gggg-hhhh-jjjj", "critical"), adv("GHSA-kkkk-mmmm-nnnn", "low")] },
      },
    };
    expect(blocking(r)).toEqual(["GHSA-aaaa-bbbb-cccc high t GHSA-aaaa-bbbb-cccc", "GHSA-gggg-hhhh-jjjj critical t GHSA-gggg-hhhh-jjjj"]);
  });
  it("an advisory with no GHSA id still blocks; an empty report passes", () => {
    expect(blocking({ vulnerabilities: { x: { via: [{ severity: "high" }] } } })).toEqual(["unknown advisory high"]);
    expect(blocking({})).toEqual([]);
  });
  it("the ignore list is the only way through: an empty list blocks the ignored advisory too", () => {
    expect(blocking({ vulnerabilities: { p: { via: [adv("GHSA-fc5q-39xc-vjpf", "high")] } } }, {})).toHaveLength(1);
  });
});
