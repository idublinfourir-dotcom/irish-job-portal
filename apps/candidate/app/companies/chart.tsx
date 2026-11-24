// The permit history chart of the company page (frame C12): permits a year, or a month, as bars. Server rendered: the "Per year" and "Per month" switch is two native
// radio buttons and CSS (no script), so the chart works with JavaScript off. Every bar carries its figure as text for a screen reader. Pure functions first, so a test can read them.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const MONTHS_SHOWN = 24;

export type YearBar = { year: number; permits: number; peak: boolean; recent: boolean };
/** The year bars: the peak year marked, and the last five calendar years (the window the permit history label counts) marked "recent". */
export const yearBars = (byYear: { year: number; permits: number }[], peakYear: number | null, thisYear: number): YearBar[] =>
  byYear.map((y) => ({ ...y, peak: y.year === peakYear, recent: y.year > thisYear - 5 }));

export type MonthBar = { year: number; month: number; permits: number };
/** The last `n` months ending at `end` (the data cut-off), every month in a row, months with no permit as 0. `byMonth` only holds months with permits. */
export function monthSeries(byMonth: MonthBar[], end: { year: number; month: number }, n = MONTHS_SHOWN): MonthBar[] {
  const have = new Map(byMonth.map((m) => [m.year * 12 + m.month - 1, m.permits]));
  const last = end.year * 12 + end.month - 1;
  return Array.from({ length: n }, (_, i) => {
    const k = last - (n - 1 - i);
    return { year: Math.floor(k / 12), month: (k % 12) + 1, permits: have.get(k) ?? 0 };
  });
}
export const shortMonth = (year: number, month: number) => `${MONTHS[month - 1]} ${year}`;
export const monthLabel = (year: number, month: number) => `${MONTH_NAMES[month - 1]} ${year}`;
const heightOf = (v: number, max: number, floor: number, span: number) => `${floor + Math.round((v / Math.max(1, max)) * span)}px`;
export const plural = (n: number) => `${n} ${n === 1 ? "permit" : "permits"}`;

const SEG = "inline-flex min-h-[34px] cursor-pointer items-center rounded-pill px-4 text-small font-semibold has-[:checked]:bg-ink has-[:checked]:text-white";

export function PermitChart({ years, months, endLabel }: { years: YearBar[]; months: MonthBar[] | null; endLabel: string | null }) {
  const maxY = Math.max(1, ...years.map((y) => y.permits));
  const maxM = Math.max(1, ...(months ?? []).map((m) => m.permits));
  return (
    <div data-permit-chart className="group">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-[18px] font-semibold">Permits issued <span className="group-has-[#chart-month:checked]:hidden">per year</span><span className="hidden group-has-[#chart-month:checked]:inline">per month</span></h3>
        {months && (
          <fieldset className="flex rounded-pill bg-lilac p-1">
            <legend className="sr-only">Show permits</legend>
            <label className={SEG}><input id="chart-year" type="radio" name="chart" defaultChecked className="peer sr-only" /><span className="flex min-h-[26px] items-center peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4">Per year</span></label>
            <label className={SEG}><input id="chart-month" type="radio" name="chart" className="peer sr-only" /><span className="flex min-h-[26px] items-center peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4">Per month</span></label>
          </fieldset>
        )}
      </div>
      <ol aria-label="DETE permits by year" data-chart="year" className="mt-6 flex h-[250px] items-end justify-around gap-2 sm:gap-4 group-has-[#chart-month:checked]:hidden">
        {years.map((y) => (
          <li key={y.year} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
            <span className={`text-small font-semibold ${y.peak ? "text-[#8a4b0f]" : ""}`}>{y.permits}<span className="sr-only"> permits in {y.year}</span></span>
            <span aria-hidden="true" data-bar={y.peak ? "peak" : y.recent ? "recent" : "older"} className={`w-full max-w-[62px] rounded-[1.125rem] ${y.peak ? "bg-[#e8a76a]" : y.recent ? "bg-ink" : "bg-deep-green"}`} style={{ height: heightOf(y.permits, maxY, 26, 160) }} />
            <span aria-hidden="true" className="text-small text-muted">{y.year}</span>
          </li>
        ))}
      </ol>
      {months && (
        <div className="hidden overflow-x-auto group-has-[#chart-month:checked]:block">
          <ol aria-label="DETE permits by month" data-chart="month" className="mt-6 flex h-[250px] min-w-[36rem] items-end gap-1">
            {months.map((m) => (
              <li key={`${m.year}-${m.month}`} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
                <span className="text-[11px] font-semibold">{m.permits}<span className="sr-only"> permits in {monthLabel(m.year, m.month)}</span></span>
                <span aria-hidden="true" className="w-full max-w-[26px] rounded-[0.6rem] bg-ink" style={{ height: heightOf(m.permits, maxM, 8, 160) }} />
                <span aria-hidden="true" className="text-[11px] leading-tight text-muted">{MONTHS[m.month - 1]}{m.month === 1 || m === months[0] ? <><br />{String(m.year).slice(-2)}</> : null}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <p className="mt-5 text-[13px] text-muted">
        <span className="group-has-[#chart-month:checked]:hidden">Dark bars are the last five years, the years our permit history label counts. </span>
        Source: DETE &ldquo;permits issued to companies&rdquo;, imported monthly.{endLabel && ` ${endLabel}`}
      </p>
    </div>
  );
}

