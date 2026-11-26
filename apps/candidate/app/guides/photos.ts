// The four guide cover photos (frames C15 and C16, 16:9, 742 x 420), imported one by one so the build hashes the file names (see _home/photos.ts).
import cover1 from "./photos/cover-1.webp";
import cover2 from "./photos/cover-2.webp";
import cover3 from "./photos/cover-3.webp";
import cover4 from "./photos/cover-4.webp";

const src = (p: string | { src: string }) => (typeof p === "string" ? p : p.src);

export const COVERS = [
  { src: src(cover1), alt: "A woman with glasses looking at her phone at a desk with a laptop and a pot of brushes." },
  { src: src(cover2), alt: "Colourful houses on a hillside in Cobh, County Cork, with the cathedral spire and the harbour behind." },
  { src: src(cover3), alt: "A Dublin street with shopfronts and lamp posts, with a church at the far end." },
  { src: src(cover4), alt: "Cumulus clouds in a blue sky." },
].map((c) => ({ ...c, width: 742, height: 420 }));

/** The same slug always gets the same cover, in the list and on the guide page. */
export function coverFor(slug: string) {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return COVERS[h % COVERS.length]!;
}
