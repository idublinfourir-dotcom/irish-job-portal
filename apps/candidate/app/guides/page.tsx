// /guides: every published guide, and the three newest government updates (P10, frame C15). Reads only through lib/data.ts.
import type { Metadata } from "next";
import { readGuides, readSignedIn, readUpdates } from "../../lib/data";
import { meta } from "../_content/meta";
import { Problem, type Failed } from "../_content/problem";
import { GuidesView, type GuideItem, type UpdateItem } from "./guides-view";

export const generateMetadata = (): Metadata => meta("Guides and government updates", "Plain-English guides to Irish employment permits and the latest government updates. Each guide shows when we last checked it against its DETE source.", "/guides");

export default async function Page() {
  const [guides, updates, signedIn] = await Promise.all([readGuides(), readUpdates(), readSignedIn()]);
  if (!guides.ok) return <Problem read={guides as Failed} what="guides" />;
  return (
    <GuidesView
      guides={(guides.data as { guides: GuideItem[] }).guides}
      updates={updates.ok ? (updates.data as { updates: UpdateItem[] }).updates.slice(0, 3) : null}
      signedIn={signedIn}
    />
  );
}
