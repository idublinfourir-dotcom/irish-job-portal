/** The month a year ago and this month, as YYYY-MM (the month picker's limits for "a degree in the last 12 months", DD14). */
export function monthLimits(now = new Date()): { min: string; max: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  return { min: `${now.getUTCFullYear() - 1}-${pad(now.getUTCMonth() + 1)}`, max: `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}` };
}
