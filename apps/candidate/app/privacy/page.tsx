// /privacy (P10, frame C22): the legal text of purpose privacy_notice, through the shared layout in _content/legal.tsx.
import { LegalPage, legalMeta } from "../_content/legal";

// Stage 3 step 5: cached at the CDN for a day; confirming a legal text clears it at once (POST /api/revalidate, LEGAL_PATHS).
export const revalidate = 86400;
export const generateMetadata = () => legalMeta("privacy_notice");
export default async function Page() {
  return LegalPage({ purpose: "privacy_notice" }); // called, not rendered as a child: a page is the async component
}
