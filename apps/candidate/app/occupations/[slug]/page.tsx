// /occupations/<name-slug>: one occupation (P10, frame C14). The address is the SOC unit group title (#288); the read takes the code. A slug that names no unit group, or a code on
// neither list, is the 404 page. Reads only through lib/data.ts.
import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { readOccupation, readSaved } from "../../../lib/data";
import { occupationCodeOfSlug, occupationTitle } from "../../../lib/occupations";
import { occupationPath } from "../../../lib/paths";
import { breadcrumbLd, canonicalUrl, occupationLd } from "../../../lib/seo";
import { PageLd } from "../../_content/ld";
import { meta } from "../../_content/meta";
import { Problem, type Failed } from "../../_content/problem";
import { OccupationView, headingOf, occupationCrumbs, titleOf, type OccupationData } from "../occupation-view";

type Props = { params: Promise<{ slug: string }> };

const load = cache((code: string) => readOccupation(new URLSearchParams({ code })));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const code = occupationCodeOfSlug((await params).slug);
  const r = code ? await load(code) : null;
  if (!r?.ok) return { title: "Occupation not found" };
  const o = r.data as OccupationData;
  const t = titleOf(o, occupationTitle(o.code));
  return meta(headingOf(t), `${t}: the salary minimums, permit notes and registration rules in force, and the live jobs where a work permit is realistic.`, occupationPath((await params).slug));
}

export default async function Page({ params }: Props) {
  const slug = (await params).slug;
  const code = occupationCodeOfSlug(slug);
  if (!code) notFound();
  const [r, mine] = await Promise.all([load(code), readSaved()]); // PERF-7: one wave; readSaved is 200 only for a signed-in candidate, and marks the saved jobs
  if (!r.ok) {
    if (r.status === 404) notFound();
    return <Problem read={r as Failed} what="occupation page" />;
  }
  const path = occupationPath(slug);
  const savedIds = mine.ok ? ((mine.data as { saved: { jobId: string }[] }).saved ?? []).map((s) => s.jobId) : [];
  const o = r.data as OccupationData, name = occupationTitle(code), title = titleOf(o, name);
  return (
    <>
      <PageLd make={(origin) => [occupationLd({ name: title, code: o.code, url: canonicalUrl(origin, path), registrationBody: o.registration?.body }), breadcrumbLd(origin, occupationCrumbs(title))]} />
      <OccupationView occupation={o} name={name} now={new Date()} path={path} signedIn={mine.ok} savedIds={savedIds} />
    </>
  );
}
