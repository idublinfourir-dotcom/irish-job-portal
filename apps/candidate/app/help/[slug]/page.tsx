// /help/<slug>: one help page (P10: frame C25 for who-needs-a-permit, and every question of the help page). Reads only through lib/data.ts; an unknown, draft or withdrawn page is the 404 page.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cachedHelp } from "../../../lib/cached";
import { helpPath } from "../../../lib/paths";
import { firstParagraph } from "../../_content/body";
import { meta } from "../../_content/meta";
import { HelpPageView, type HelpPageData } from "../help-page-view";

type Props = { params: Promise<{ slug: string }> };

// Stage 3 step 5: each help page is rendered on its first visit and cached for an hour; a content publish or withdraw clears them all (CONTENT_PATHS).
// Read as a visitor; a failed read throws, so a regeneration keeps the last good copy. Nothing is rendered at build.
export const revalidate = 3600;
export const generateStaticParams = async () => [];
const load = async (slug: string) => (await cachedHelp(slug)) as HelpPageData | null;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = await load((await params).slug);
  if (!p) return { title: "Help page not found" };
  return meta(p.title, firstParagraph(p.body) ?? `${p.title}: help from the Irish Work Permit team.`, helpPath(p.slug));
}

export default async function Page({ params }: Props) {
  const p = await load((await params).slug);
  if (!p) notFound();
  return <HelpPageView page={p} signedIn={false} />;
}
