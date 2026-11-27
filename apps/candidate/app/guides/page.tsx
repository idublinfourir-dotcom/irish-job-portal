// /guides: every published guide, and the three newest government updates (P10, frame C15). Reads only through lib/data.ts.
import type { Metadata } from "next";
import { cachedGuides, cachedUpdates } from "../../lib/cached";
import { meta } from "../_content/meta";
import { GuidesView, type GuideItem, type UpdateItem } from "./guides-view";

export const generateMetadata = (): Metadata => meta("Guides and government updates", "Plain-English guides to Irish employment permits and the latest government updates. Each guide shows when we last checked it against its DETE source.", "/guides");

// Stage 3 step 5: cached at the CDN for an hour; a content publish or withdraw clears it (CONTENT_PATHS). Read as a visitor; a failed read throws.
export const revalidate = 3600;

export default async function Page() {
  const [guides, updates] = (await Promise.all([cachedGuides(), cachedUpdates()])) as [{ guides: GuideItem[] }, { updates: UpdateItem[] }];
  return <GuidesView guides={guides.guides} updates={updates.updates.slice(0, 3)} signedIn={false} />;
}
