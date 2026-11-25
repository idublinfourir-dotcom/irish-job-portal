// What the degree box says (C08): pure, from the minimums the job read carries (B6), so a click needs no request. Every figure is read, never typed.
export type DegreeChoice = "relevant" | "last_12_months" | "none";
/** The three answers; the length of "recent" is the rules' graduateMonths, read, so it is never typed here. */
export const degreeChoices = (graduateMonths: number): [DegreeChoice, string][] => [
  ["relevant", "I have a relevant degree"],
  ["last_12_months", `I got my degree in the last ${graduateMonths} months`],
  ["none", "I don't have a relevant degree"],
];
export type Minimums = {
  criticalSkills: number; graduate: number; graduateMonths: number; nonList: number | null; minContractMonths: number; standardWeekHours: number;
  general: number | null; generalLower: number | null; generalLowerCodes: string[] | null;
};
/** `hse`: the employer is the HSE itself (its own name, `publicPayTier`). */
export type Pay = { passRoute: string | null; salaryLow: number | null; salaryHigh: number | null; hse?: boolean };
/** How the stated pay stands against a minimum. `depends`: the range starts below it and ends at or above it. `unstated`: no pay in the advert. */
export type Standing = "clears" | "depends" | "below" | "unstated";
export type DegreeResult =
  | { kind: "public_pay"; needsDegree?: true } // no salary minimum applies: the job follows a public sector pay scale. needsDegree: the candidate said they have no relevant degree
  | { kind: "route_closed" } // no minimum is published for this case (the route without a degree is off)
  | { kind: "minimum"; minimum: number; standing: Standing; basis: "big_company" | "pay_floor" | null };

export function standing(pay: Pay, minimum: number): Standing {
  const low = pay.salaryLow ?? pay.salaryHigh;
  const high = pay.salaryHigh ?? pay.salaryLow;
  if (low === null || high === null) return "unstated";
  if (low >= minimum) return "clears";
  return high >= minimum ? "depends" : "below";
}
function against(pay: Pay, minimum: number): DegreeResult {
  const s = standing(pay, minimum);
  const basis = s === "unstated" ? (pay.passRoute === "big_company" || pay.passRoute === "pay_floor" ? pay.passRoute : null) : null;
  return { kind: "minimum", minimum, standing: s, basis };
}
/** A Critical Skills job: the minimum for the candidate's degree. */
export function criticalSkillsResult(choice: DegreeChoice, m: Minimums, pay: Pay): DegreeResult {
  // #67, #300: the public pay route needs the relevant degree, so without one the higher minimum is what is left. The HSE keeps its pay scale line and says the degree is needed:
  // its clinical jobs cannot be done without one, and most of its scales never reach that minimum, so a figure there would only mislead.
  if (pay.passRoute === "public_pay" && choice !== "none") return { kind: "public_pay" };
  if (pay.passRoute === "public_pay" && pay.hse) return { kind: "public_pay", needsDegree: true };
  const minimum = choice === "relevant" ? m.criticalSkills : choice === "last_12_months" ? m.graduate : m.nonList;
  return minimum === null ? { kind: "route_closed" } : against(pay, minimum);
}
/** A General permit job: one minimum (or the lower one for its code), no degree question. null until the rules carry General figures. */
export function generalResult(m: Minimums, code: string | null, pay: Pay): DegreeResult | null {
  if (pay.passRoute === "public_pay") return { kind: "public_pay" };
  const minimum = code !== null && m.generalLowerCodes?.includes(code) && m.generalLower !== null ? m.generalLower : m.general;
  return minimum === null ? null : against(pay, minimum);
}
