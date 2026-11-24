// /eligibility-checker: the checker (P10, frame C18), as built. A plain GET form: the page reads the answers from its address, checks them (input.ts), asks the checker read, and shows the result.
// Reads only through lib/data.ts. Nothing is stored. The occupation list comes from the occupations read (B12, the picker); if that read fails the form still works with a typed code.
import type { Metadata } from "next";
import { readChecker, readOccupations, readSignedIn } from "../../lib/data";
import { staticPath } from "../../lib/paths";
import { meta } from "../_content/meta";
import { CheckerView, type Answer } from "./checker-view";
import { parseChecker, type Occupation } from "./input";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

// The result page is noindex (every answer would be its own address); the empty form is the indexed page.
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const filtered = Object.keys(await searchParams).length > 0;
  return meta("Eligibility checker", "Check whether a job offer could qualify for an Irish Critical Skills employment permit. The same rules as our job badges. Guidance, not legal advice.", staticPath("eligibility-checker")!, filtered);
}

export default async function Page({ searchParams }: Props) {
  const sp = await searchParams;
  const [list, signedIn] = await Promise.all([readOccupations(), readSignedIn()]);
  const occupations = list.ok ? (list.data as { occupations: Occupation[] }).occupations : null;
  const parsed = parseChecker(sp, occupations ?? []);
  let answer: Answer | null = null;
  let failed: { status: number } | null = null;
  if (parsed.query) {
    const r = await readChecker(parsed.query);
    if (r.ok) answer = r.data as Answer;
    else failed = { status: r.status };
  }
  return <CheckerView parsed={parsed} occupations={occupations} answer={answer} failed={failed} signedIn={signedIn} />;
}
