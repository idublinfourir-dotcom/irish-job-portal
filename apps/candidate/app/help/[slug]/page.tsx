// /help/<slug>: one help page (P10: frame C25 for who-needs-a-permit, and every question of the help page). Reads only through lib/data.ts; an unknown, draft or withdrawn page is the 404 page.
import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { readHelp, readSignedIn } from "../../../lib/data";
import { helpPath } from "../../../lib/paths";
import { firstParagraph } from "../../_content/body";
import { meta } from "../../_content/meta";
import { Problem, type Failed } from "../../_content/problem";
import { HelpPageView, type HelpPageData } from "../help-page-view";

type Props = { params: Promise<{ slug: string }> };

const load = cache((slug: string) => readHelp(new URLSearchParams({ slug })));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const r = await load(slug);
  if (!r.ok) return { title: "Help page not found" };
  const p = r.data as HelpPageData;
  return meta(p.title, firstParagraph(p.body) ?? `${p.title}: help from the Irish Work Permit team.`, helpPath(p.slug));
}

export default async function Page({ params }: Props) {
  const { slug } = await params;
  const r = await load(slug);
  if (!r.ok) {
    if (r.status === 404) notFound();
    return <Problem read={r as Failed} what="help page" back={{ href: "/help", label: "Open the help page" }} />;
  }
  return <HelpPageView page={r.data as HelpPageData} signedIn={await readSignedIn()} />;
}
