// The eligibility checker (#94, #223): a pure function from a person's or an offer's facts to "qualifies or not, which minimum, why".
// Built on the same numbers as the badges: the rules snapshot (#229), its minimums and its Critical Skills / Ineligible lists. The caller passes it.
import { isSoc2010 } from "./soc";
import type { Minimums } from "./snapshot";
import { minimumForHours, standingLine } from "./thresholds";

export type OccupationLists = readonly { code: string; list: string }[];
export type EligibilityInput = {
  occupationCode: string;
  /** Gross pay for a year, in euro. */
  annualPay: number;
  relevantDegree: boolean;
  /** "YYYY-MM": the month the degree was awarded. Only read with a relevant degree. */
  degreeAwardMonth?: string | null;
  /** null: permanent, or no end date. */
  contractMonths: number | null;
  /** Default 39, DETE's standard week. */
  weeklyHours?: number;
};
export type EligibilityReason =
  | "unknown_code" | "ineligible" | "contract_too_short" | "listed_degree" | "recent_graduate" | "non_list_route"
  | "below_minimum" | "degree_needed" | "non_list_route_blocked";
export type EligibilityResult = { qualifies: boolean; reason: EligibilityReason; minimum: number | null; why: string; standingLine: string; rulesCheckedOn: string };

/** A bad input (not a bad case): the route answers 400. */
export class BadEligibilityInput extends Error {}

const eur = (n: number) => `€${n.toLocaleString("en-IE", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2 })}`;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Whole months from the award month to `now`. Negative: the award month is still ahead. */
export function monthsSince(awardMonth: string, now: Date): number {
  const m = MONTH.exec(awardMonth);
  if (!m) throw new BadEligibilityInput("degree award month must be YYYY-MM");
  return (now.getUTCFullYear() - Number(m[1])) * 12 + (now.getUTCMonth() + 1 - Number(m[2]));
}

export function checkEligibility(
  input: EligibilityInput,
  rules: { minimums: Minimums; occupationLists: OccupationLists },
  opts: { now?: Date; nonListRoute?: boolean } = {},
): EligibilityResult {
  const m = rules.minimums, lists = rules.occupationLists;
  const { occupationCode: code, annualPay: pay, relevantDegree, degreeAwardMonth, contractMonths, weeklyHours = m.standardWeekHours } = input;
  const now = opts.now ?? new Date();
  const nonListRoute = opts.nonListRoute ?? m.nonListRoute;
  const forHours = (annual: number) => minimumForHours(annual, weeklyHours, m.standardWeekHours);
  if (typeof code !== "string" || typeof relevantDegree !== "boolean") throw new BadEligibilityInput("bad input");
  if (!Number.isFinite(pay) || pay < 0) throw new BadEligibilityInput("annual pay must be a number of euro, 0 or more");
  if (!Number.isFinite(weeklyHours) || weeklyHours < 1 || weeklyHours > 60) throw new BadEligibilityInput("weekly hours must be 1 to 60");
  if (contractMonths !== null && (!Number.isFinite(contractMonths) || contractMonths < 0)) throw new BadEligibilityInput("contract months must be 0 or more, or null");
  const months = relevantDegree && degreeAwardMonth ? monthsSince(degreeAwardMonth, now) : null;

  const done = (qualifies: boolean, reason: EligibilityReason, minimum: number | null, why: string): EligibilityResult =>
    ({ qualifies, reason, minimum, why, standingLine: standingLine(m.checkedOn), rulesCheckedOn: m.checkedOn });

  if (!isSoc2010(code)) return done(false, "unknown_code", null, "That is not an official SOC 2010 occupation code.");
  // ponytail: 2229 is on both lists (orthoptists listed, other therapists ineligible); like listAnswer in admin-queue, the Critical Skills entry wins.
  const onList = lists.some((e) => e.code === code && e.list === "critical-skills");
  if (!onList && lists.some((e) => e.code === code && e.list === "ineligible"))
    return done(false, "ineligible", null, "This occupation is on the Ineligible list, so it cannot get a Critical Skills permit.");
  if (contractMonths !== null && contractMonths < m.minContractMonths)
    return done(false, "contract_too_short", null, `A Critical Skills permit needs a contract of at least ${m.minContractMonths} months. A shorter one goes to a General permit.`);

  const nonList = forHours(m.nonList);
  if (onList && relevantDegree) {
    const graduate = months !== null && months >= 0 && months <= m.graduateMonths;
    const base = graduate ? m.graduate : m.criticalSkills;
    const minimum = forHours(base);
    if (pay >= minimum)
      return done(true, graduate ? "recent_graduate" : "listed_degree", minimum,
        graduate ? `Recent graduate (degree within ${m.graduateMonths} months): the minimum is ${eur(minimum)}.` : `On the Critical Skills list with a relevant degree: the minimum is ${eur(minimum)}.`);
    // every listed minimum is below the non-list one, so pay under it cannot reach the higher route either
    return done(false, "below_minimum", minimum, `Pay is below the ${eur(minimum)} minimum.`);
  }
  if (nonListRoute) {
    if (pay >= nonList)
      return done(true, "non_list_route", nonList,
        `Pay of ${eur(nonList)} or more qualifies any role not on the Ineligible list. Without a relevant degree DETE asks for the necessary level of experience.`);
    if (onList && !relevantDegree)
      return done(false, "degree_needed", nonList, `The ${eur(forHours(m.criticalSkills))} minimum for a listed role needs a relevant degree. Without one, pay of ${eur(nonList)} or more is needed.`);
    return done(false, "below_minimum", nonList, `This occupation is not on the Critical Skills list, so pay of ${eur(nonList)} or more is needed.`);
  }
  return done(false, onList ? "degree_needed" : "non_list_route_blocked", null,
    onList ? "A relevant degree is needed for a listed role." : "This occupation is not on the Critical Skills list, and the higher-pay route is not open.");
}
