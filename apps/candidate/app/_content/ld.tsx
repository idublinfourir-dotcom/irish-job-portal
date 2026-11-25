// A page's JSON-LD (frame 01 SEO spec). Nothing where the site has no address yet; a builder that answers null (a job with no markup) is left out.
import { jsonLd } from "../../lib/seo";
import { originOrNull } from "./meta";

export function PageLd({ make }: { make: (origin: string) => (Record<string, unknown> | null)[] }) {
  const origin = originOrNull();
  return origin && make(origin).filter((d) => d !== null).map((d, i) => <script key={i} type="application/ld+json">{jsonLd(d)}</script>);
}
