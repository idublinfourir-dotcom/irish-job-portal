// /companies/<slug>: one company (P9, frame C12). Reads only through lib/data.ts. A merged company redirects to the company it was merged into (308, the slug is the page's address);
// an unknown, rejected or closed company, or a slug that is not a slug, is the 404 page (there is no record of old slugs, so an old one cannot be told from a wrong one). A company
// with no live job still has its page. A visitor sees the first 6 jobs (the read enforces it); a signed-in candidate pages with Previous and Next.
import { cache } from "react";
import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { readCompany, readSaved } from "../../../lib/data";
import { companyPath } from "../../../lib/paths";
import { meta } from "../../_content/meta";
import { Problem, type Failed } from "../../_content/problem";
import { cursorOf, pagerLinks, parseTrail } from "../../_content/trail";
import { CompanyView, type CompanyData } from "../company-view";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

// One read per request, shared by generateMetadata and the page (each gated read counts against the read limit).
const load = cache((slug: string, after: string) => readCompany(new URLSearchParams({ slug, ...(after ? { after } : {}) })));

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { slug } = await params;
  const after = cursorOf((await searchParams).after) ?? "";
  const r = await load(slug, after);
  if (!r.ok || "merged" in (r.data as object)) return { title: "Company not found" };
  const c = r.data as CompanyData;
  return meta(`${c.name} jobs and permit history`, `${c.name}${c.county ? ` in ${c.county}` : ""}: live jobs where a work permit is realistic, its DETE permit history and the labels we show on its jobs.`, companyPath(c.slug), after !== "");
}

export default async function Page({ params, searchParams }: Props) {
  const { slug } = await params;
  const sp = await searchParams;
  const after = cursorOf(sp.after);
  const [r, mine] = await Promise.all([load(slug, after ?? ""), readSaved()]);
  const path = companyPath(slug);
  if (!r.ok) {
    if (r.status === 404) notFound();
    return <Problem read={r as Failed} what="company page" back={{ href: path, label: "Open the company page" }} path={path} />;
  }
  if ("merged" in (r.data as object)) permanentRedirect(companyPath((r.data as { merged: string }).merged));
  const company = r.data as CompanyData & { jobs: { next: string | null } };
  const links = pagerLinks({ base: path, after, back: parseTrail(sp.back), next: company.jobs.next });
  const signedIn = mine.ok;
  const savedIds = mine.ok ? ((mine.data as { saved: { jobId: string }[] }).saved ?? []).map((s) => s.jobId) : [];
  return <CompanyView company={company} now={new Date()} signedIn={signedIn} savedIds={savedIds} path={path} {...links} />;
}
