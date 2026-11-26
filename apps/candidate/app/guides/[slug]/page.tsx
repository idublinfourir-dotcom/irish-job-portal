// /guides/<slug>: one guide (P10, frame C16). Reads only through lib/data.ts. The body is the plain text staff typed (Q2, the body format, is open), shown by _content/body.tsx.
// Not built: "On this page", related guides and the cover (decision #287, L23; the first two also wait for the body format), tables typed in the text (CF11: figures come from the minimums read).
import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { readGuide, readSignedIn } from "../../../lib/data";
import { guidePath } from "../../../lib/paths";
import { meta } from "../../_content/meta";
import { firstParagraph } from "../../_content/body";
import { Problem, type Failed } from "../../_content/problem";
import { GuideView, type GuideData } from "../guide-view";

type Props = { params: Promise<{ slug: string }> };

const load = cache((slug: string) => readGuide(new URLSearchParams({ slug })));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const r = await load(slug);
  if (!r.ok) return { title: "Guide not found" };
  const g = r.data as GuideData;
  return meta(g.title, firstParagraph(g.body) ?? `${g.title}: a plain-English guide to Irish employment permits.`, guidePath(g.slug));
}

export default async function Page({ params }: Props) {
  const { slug } = await params;
  const r = await load(slug);
  if (!r.ok) {
    if (r.status === 404) notFound();
    return <Problem read={r as Failed} what="guide" back={{ href: "/guides", label: "All guides" }} />;
  }
  return <GuideView guide={r.data as GuideData} signedIn={await readSignedIn()} />;
}
