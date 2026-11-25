// The checker's input (frame C18, "as built", decision #287 L25): what the page takes from its address, checked before any read, and the query the checker read takes. Pure.
// The form is a plain GET form, so a result has an address that can be shared or bookmarked, and nothing is stored. Seven fields at most: occupation, pay, degree, degree month,
// contract length, weekly hours, job title. A bad answer is worded next to its field and no read is made.
export type Occupation = { code: string; title: string; slug: string; listStatus: string };
export type Raw = Record<string, string | string[] | undefined>;
export const FIELDS = ["occupation", "pay", "degree", "degreeMonth", "months", "hours", "title"] as const;
export type Field = (typeof FIELDS)[number];
export type Values = Record<Field, string>;
export type Parsed = { submitted: boolean; values: Values; errors: Partial<Record<Field, string>>; query: URLSearchParams | null; code: string | null };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const clip = (s: string, n: number) => s.slice(0, n);
/** The way a picker option reads: "Nurses (2231)". The page's datalist offers these, and so does the parser take them back. */
export const optionText = (o: Occupation) => `${o.title} (${o.code})`;

/** The code a typed occupation means: a bare 4-digit code, "Title (1234)", or a title written exactly (any case); null when it is none of them. */
export function codeOf(text: string, list: readonly Occupation[]): string | null {
  const t = text.trim();
  const bare = /^(?:.*\()?([0-9]{4})\)?$/.exec(t)?.[1];
  if (bare && (list.length === 0 || list.some((o) => o.code === bare))) return bare;
  const lower = t.toLowerCase();
  return list.find((o) => o.title.toLowerCase() === lower)?.code ?? null;
}

export function parseChecker(raw: Raw, list: readonly Occupation[]): Parsed {
  const submitted = FIELDS.some((f) => f in raw);
  const values = Object.fromEntries(FIELDS.map((f) => [f, clip(first(raw[f]).trim(), f === "title" ? 200 : 120)])) as Values;
  const errors: Partial<Record<Field, string>> = {};
  if (!submitted) return { submitted, values, errors, query: null, code: null };

  const code = codeOf(values.occupation, list);
  if (!values.occupation) errors.occupation = "Choose an occupation.";
  else if (!code) errors.occupation = "Choose an occupation from the list, or type its four-digit code.";

  const pay = values.pay.replace(/[€\s,]/g, "");
  if (!pay) errors.pay = "Enter the yearly salary offered.";
  else if (!/^[0-9]{1,7}(\.[0-9]{1,2})?$/.test(pay)) errors.pay = "Enter the salary as a number of euro a year, for example 42000.";

  if (values.degree !== "yes" && values.degree !== "no") errors.degree = "Say whether you have a relevant degree.";
  if (values.degree === "yes" && values.degreeMonth && !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(values.degreeMonth)) errors.degreeMonth = "Choose the month and year you got your degree.";
  if (values.months && !/^[0-9]{1,3}$/.test(values.months)) errors.months = "Enter the contract length as a whole number of months, or leave it empty for a permanent job.";
  if (values.hours && !(/^[0-9]{1,2}(\.[0-9]{1,2})?$/.test(values.hours) && Number(values.hours) >= 1 && Number(values.hours) <= 60)) errors.hours = "Enter the hours a week, from 1 to 60.";
  if (/[\p{Cc}\p{Cf}]/u.test(values.title)) errors.title = "The job title cannot hold control characters.";

  if (Object.keys(errors).length > 0 || !code) return { submitted, values, errors, query: null, code };
  const q = new URLSearchParams({ occupationCode: code, annualPay: pay, relevantDegree: String(values.degree === "yes") });
  if (values.degree === "yes" && values.degreeMonth) q.set("degreeAwardMonth", values.degreeMonth);
  if (values.months) q.set("contractMonths", values.months);
  if (values.hours) q.set("weeklyHours", values.hours);
  if (values.title) q.set("title", values.title);
  return { submitted, values, errors, query: q, code };
}
