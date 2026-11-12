// The numbers the Critical Skills rules turn on, in one place (#227 D9). Read on DETE's own pages on 12 November 2026
// (step9/dete-thresholds-research.md). Change a figure and RULES_CHECKED_ON together, so every page shows the date the figures were read.

/** Critical Skills list role, relevant degree. Based on a 39-hour week. */
export const CRITICAL_SKILLS_MINIMUM = 40_904;
/** Critical Skills list role, recent graduate (level 8 or higher degree relevant to the role). */
export const GRADUATE_MINIMUM = 36_848;
/** "Recent": the qualification was received within this many months before the application. */
export const GRADUATE_MONTHS = 12;
/**
 * Any role not on the Ineligible list. No degree is needed, but without one DETE asks for "the necessary level of experience".
 * DETE's page says "over" and its checklist says "is": we follow the checklist, so every minimum here is compared with >=.
 */
export const NON_LIST_MINIMUM = 68_911;
/** #225, confirmed by DETE's pages on 12 November 2026: an employer may post a non-list role at NON_LIST_MINIMUM or more. */
export const NON_LIST_ROUTE: boolean = true;
/** A shorter contract goes to a General permit, not a Critical Skills one. */
export const MIN_CONTRACT_MONTHS = 24;
/** DETE's figures assume this week. */
export const STANDARD_WEEK_HOURS = 39;

/** The date these figures were last read on DETE's pages: "Rules last checked on [date]" (#94). */
export const RULES_CHECKED_ON = "2026-11-12";
export const standingLine = (date: string = RULES_CHECKED_ON) =>
  `Our check is guidance, not a permit decision. Only DETE decides. Rules last checked on ${date}.`;

/**
 * DETE: "40,904 is based on a 39-hour week, €20.17"; a 40-hour week needs 41,953.60. Over 39 hours the minimum is the hourly rate
 * (the 39-hour rate rounded to cents) times the hours times 52, never less than the annual minimum. Whole cents, so no float drift.
 * Runtime callers pass the snapshot's `standardWeekHours` as `standardWeek` (#229); the default is version 1.
 */
export function minimumForHours(annualMinimum: number, weeklyHours: number = STANDARD_WEEK_HOURS, standardWeek: number = STANDARD_WEEK_HOURS): number {
  if (weeklyHours <= standardWeek) return annualMinimum;
  const hourlyCents = Math.round((annualMinimum * 100) / (standardWeek * 52));
  return Math.max(annualMinimum, Math.round(hourlyCents * weeklyHours * 52) / 100);
}
