// /occupations/<name-slug>: one occupation (P10, frame C14). The address is the SOC unit group title (#288); the read takes the code. A slug that names no unit group, or a code on
// neither list, is the 404 page. Stage 3 step 6: cached at the CDN for 5 minutes, read as a visitor through lib/cached.ts (the first 6 jobs); a candidate's saved
// marks come from the saved route in the browser (SavedMarksFromApi), the rest follows the hint switch. Rendered on its first visit, never at build.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cachedOccupation } from "../../../lib/cached";
import { occupationCodeOfSlug, occupationTitle } from "../../../lib/occupations";
import { occupationPath } from "../../../lib/paths";
import { breadcrumbLd, canonicalUrl, occupationLd } from "../../../lib/seo";
import { PageLd } from "../../_content/ld";
import { meta } from "../../_content/meta";
import { SavedMarksFromApi } from "../../jobs/client";
import { OccupationView, headingOf, occupationCrumbs, titleOf, type OccupationData } from "../occupation-view";

type Props = { params: Promise<{ slug: string }> };

export const revalidate = 300;
export const generateStaticParams = async () => [];
const load = async (code: string) => (await cachedOccupation(code)) as OccupationData | null;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const code = occupationCodeOfSlug((await params).slug);
  const o = code ? await load(code) : null;
  if (!o) return { title: "Occupation not found" };
  const t = titleOf(o, occupationTitle(o.code));
  return meta(headingOf(t), `${t}: the salary minimums, permit notes and registration rules in force, and the live jobs where a work permit is realistic.`, occupationPath((await params).slug));
}

export default async function Page({ params }: Props) {
  const slug = (await params).slug;
  const code = occupationCodeOfSlug(slug);
  const o = code ? await load(code) : null;
  if (!code || !o) notFound();
  const path = occupationPath(slug);
  const name = occupationTitle(code), title = titleOf(o, name);
  return (
    <SavedMarksFromApi>
      <PageLd make={(origin) => [occupationLd({ name: title, code: o.code, url: canonicalUrl(origin, path), registrationBody: o.registration?.body }), breadcrumbLd(origin, occupationCrumbs(title))]} />
      <OccupationView occupation={o} name={name} now={new Date()} path={path} signedIn={undefined} />
    </SavedMarksFromApi>
  );
}
