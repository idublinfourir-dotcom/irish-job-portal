// /jobs: the search results (P7). Reads only through lib/data.ts. A visitor gets the first jobs of a search (the read enforces the cap, the page shows
// the state); a signed-in candidate gets pages, save and alerts. A signed-in candidate is told by readSaved (401 for a visitor), which also marks saved jobs.
import type { Metadata } from "next";
import { readJobs, readMinimums, readOccupations, readSaved, readSectors } from "../../lib/data";
import { staticPath } from "../../lib/paths";
import { breadcrumbLd, isFilteredSearch } from "../../lib/seo";
import { PageLd } from "../_content/ld";
import { meta } from "../_content/meta";
import type { CardJob } from "./card";
import { parseSearch, queryOf, readQuery, searchDescription, searchTitle } from "./format";
import { SearchView, searchCrumbs, type ListRead, type RuleMinimums } from "./search";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const state = parseSearch(await searchParams);
  // Our own filters, sort and paging make a second copy of /jobs; a key we do not know (a campaign tag) is the same page and only needs the canonical.
  return meta(searchTitle(state.filters), searchDescription(state.filters), staticPath("jobs")!, isFilteredSearch(Object.fromEntries(readQuery(state))));
}

type Answer = { jobs: CardJob[]; next: string | null; previous: string | null; count: { n: number; more: boolean } | null; signInForMore: boolean };
const asList = (r: Awaited<ReturnType<typeof readJobs>>): ListRead => (r.ok ? { ok: true, ...(r.data as Answer) } : { ok: false, status: r.status, code: r.code, ...("retryAfter" in r ? { retryAfter: r.retryAfter } : {}) });

export default async function Page({ searchParams }: Props) {
  const state = parseSearch(await searchParams);
  // PERF-7: one wave. The two reads that wait for another answer are chained inside it, so they still run only when needed: the newest sponsor jobs
  // when the search is empty, the minimums (the visitor's "Permit rules" card) when readSaved says a visitor (401).
  const listRead = readJobs(readQuery(state)), savedRead = readSaved();
  const [read, mine, counts, titles, newest, rules] = await Promise.all([
    listRead,
    savedRead,
    readSectors(queryOf(state)), // B11: the counts of the other filters (the read leaves the sector filter out of its own counts)
    state.filters.occupationCode ? readOccupations() : null,
    listRead.then((r) => (r.ok && (r.data as Answer).jobs.length === 0 ? readJobs(new URLSearchParams({ badge: "sponsor_confirmed", sort: "newest" })) : null)),
    savedRead.then((m) => (m.ok ? null : readMinimums())),
  ]);
  const list = asList(read);
  const signedIn = mine.ok;
  const savedIds = mine.ok ? ((mine.data as { saved: { jobId: string }[] }).saved ?? []).map((s) => s.jobId) : [];
  return (
    <>
      <PageLd make={(origin) => [breadcrumbLd(origin, searchCrumbs())]} />
      <SearchView
        state={state}
        now={new Date()}
        list={list}
        signedIn={signedIn}
        savedIds={savedIds}
        sectorCounts={counts?.ok ? (counts.data as { sectors: { sector: string; jobs: number }[] }).sectors : undefined}
        occupationTitle={titles?.ok ? (titles.data as { occupations: { code: string; title: string }[] }).occupations.find((o) => o.code === state.filters.occupationCode)?.title ?? null : null}
        minimums={rules?.ok ? (rules.data as RuleMinimums) : null}
        newest={newest?.ok ? (newest.data as Answer).jobs.slice(0, 2) : undefined}
      />
    </>
  );
}
