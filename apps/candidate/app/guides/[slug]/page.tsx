// /guides/<slug>: one guide (P10, frame C16). Reads only through lib/data.ts. The body is the plain text staff typed (Q2, the body format, is open), shown by _content/body.tsx.
// Not built: "On this page", related guides and the cover (decision #287, L23; the first two also wait for the body format), tables typed in the text (CF11: figures come from the minimums read).
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cachedGuide } from "../../../lib/cached";
import { guidePath } from "../../../lib/paths";
import { meta } from "../../_content/meta";
import { firstParagraph } from "../../_content/body";
import { GuideView, type GuideData } from "../guide-view";

type Props = { params: Promise<{ slug: string }> };

// Stage 3 step 5: each guide is rendered on its first visit and cached for an hour; a content publish or withdraw clears them all (CONTENT_PATHS).
// Read as a visitor; a failed read throws, so a regeneration keeps the last good copy. Nothing is rendered at build.
export const revalidate = 3600;
export const generateStaticParams = async () => [];
const load = async (slug: string) => (await cachedGuide(slug)) as GuideData | null; // metadata and page each read once a regeneration, never per visit

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const g = await load((await params).slug);
  if (!g) return { title: "Guide not found" };
  return meta(g.title, firstParagraph(g.body) ?? `${g.title}: a plain-English guide to Irish employment permits.`, guidePath(g.slug));
}

export default async function Page({ params }: Props) {
  const g = await load((await params).slug);
  if (!g) notFound();
  return <GuideView guide={g} signedIn={false} />;
}
