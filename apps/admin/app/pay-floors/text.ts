// The words of the pay floor check queue, pure so a test covers them. The signer's name and title are typed by an employer: text only.
import type { FloorCheck } from "@portal/db";
import { eur } from "../employer-jobs/text";

export const REJECT_REASONS: readonly (readonly [string, string])[] = [
  ["not_big_company", "Not on the big-company list"], ["signer_not_authorised", "The signer is not authorised"], ["amount_not_supported", "The amount is not supported"], ["other", "Another reason"],
];
export const isEditor = (roles: readonly string[]) => roles.includes("rules_data_editor");
export const isAdmin = (roles: readonly string[]) => roles.includes("administrator");

export type Step = "propose" | "confirm" | "wait_other" | "wait_second";
/** What the signed-in staff member may do next with a floor: the editor proposes; a different administrator confirms; the proposer waits for that second person. */
export function stepFor(f: Pick<FloorCheck, "requestId" | "proposedBy">, me: string, roles: readonly string[]): Step | null {
  if (f.requestId === null) return isEditor(roles) ? "propose" : isAdmin(roles) ? "wait_other" : null;
  if (f.proposedBy === me) return "wait_second";
  return isAdmin(roles) ? "confirm" : "wait_second";
}
export const floorLine = (f: Pick<FloorCheck, "floorEur" | "currentFloorEur">): string =>
  f.currentFloorEur === null ? `${eur(f.floorEur)} a year (no floor in force for this occupation)` : `${eur(f.floorEur)} a year, replacing ${eur(f.currentFloorEur)}`;
