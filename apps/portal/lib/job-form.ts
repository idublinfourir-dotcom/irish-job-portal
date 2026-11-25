// B51: what the posting form needs to read before it can be filled in: the sponsorship statement wording in force, the occupation picker's list, and the
// #66 range note with the graduate minimum, both from rules data (never typed here). Any signed-in portal login; no parameters.
import { getPool, getRules, occupationPicker } from "@portal/db";
import { no, ok, portalLogin } from "./company";

export const STATEMENT_READ = `select version, body, published_at::text as "publishedAt" from consent_text where purpose = 'sponsorship_statement' order by published_at desc, id desc limit 1`;

/** The #66 note for a range that starts below the minimum. Placeholder wording (real copy comes with the page); the figure is the graduate minimum in force. */
export const rangeNote = (graduate: number) =>
  `Pay depends on where you start on the scale. Experienced candidates, and recent graduates (€${graduate.toLocaleString("en-IE")} minimum), usually qualify. Employer-paid health insurance also counts.`;

export async function jobFormGet(request: Request): Promise<Response> {
  const login = await portalLogin(request);
  if (login instanceof Response) return login;
  if ([...new URL(request.url).searchParams.keys()].length) return no(400, "BAD_REQUEST");
  const db = getPool();
  const [statement, picker, rules] = await Promise.all([db.query(STATEMENT_READ), occupationPicker(db), getRules(db)]);
  const graduate = rules.minimums.graduate;
  return ok({ statement: statement.rows[0] ?? null, occupations: picker.occupations, graduateMinimum: graduate, rangeNote: rangeNote(graduate) });
}
