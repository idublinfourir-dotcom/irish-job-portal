// The CRO look-up as the claim search answers it. Not in company-forms.tsx: the first-time page runs it on the server, where a function of a "use client" file throws (a 500).
import type { Reply } from "./api";

export type Match = { organisationId: string | null; name: string; croNumber: string | null; county: string | null };
export type Found = { kind: "found"; name: string; county: string | null } | { kind: "onsite" } | { kind: "none" } | { kind: "error"; text: string };
export const asMatches = (body: Reply["body"]): Match[] => (Array.isArray(body.results) ? (body.results as Match[]) : []);
/** The look-up of a CRO number in the register data, as the claim search answers it (the page runs it too, for a number the claim step handed over). */
export function croFound(body: Reply["body"], cro: string): Found {
  const want = cro.replace(/\s+/g, "").replace(/^ie/i, "").replace(/^0+/, "");
  const hit = asMatches(body).find((m) => m.croNumber?.replace(/^0+/, "") === want);
  return !hit ? { kind: "none" } : hit.organisationId ? { kind: "onsite" } : { kind: "found", name: hit.name, county: hit.county };
}
