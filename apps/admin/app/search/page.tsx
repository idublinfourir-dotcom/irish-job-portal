import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SITE_NAME } from "@portal/ui";
import { readSearch } from "../../lib/data";
import type { StaffSearch } from "@portal/db";
import { SearchView } from "./search-view";

export const metadata: Metadata = { title: `Search, ${SITE_NAME} admin`, robots: { index: false, follow: false } };

type Params = { q?: string | string[] };
const MIN = 3, MAX = 100;

/** The result of one search, or why there is none: too short, not valid, or not signed in (to the sign-in page). */
async function load(q: string): Promise<{ found?: StaffSearch; problem?: string }> {
  const t = q.trim();
  if (t.length < MIN) return { problem: `Type at least ${MIN} characters.` };
  if (t.length > MAX || /\p{Cc}/u.test(t)) return { problem: `Use ${MAX} characters or fewer, with no control characters.` };
  try {
    return { found: await readSearch(t) };
  } catch (e) {
    const why = e instanceof Error ? e.message : "";
    if (why === "no_session" || why === "not_active" || why === "not_active_staff") redirect("/sign-in"); // a visitor, an ended session or a disabled login
    if (why === "bad_query") return { problem: "That text cannot be searched." };
    throw e;
  }
}

export default async function Page({ searchParams }: { searchParams: Promise<Params> }) {
  const raw = (await searchParams).q;
  const q = typeof raw === "string" ? raw : "";
  const { found, problem } = raw === undefined ? { found: undefined, problem: undefined } : await load(q);
  return <SearchView q={q} found={found} problem={problem} />;
}
