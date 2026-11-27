// /data-retention (P10, frame C22): the legal text of purpose data_retention, through the shared layout in _content/legal.tsx.
import { LegalPage, legalMeta } from "../_content/legal";

// Stage 3 step 5: cached at the CDN for a day; confirming a legal text clears it at once (POST /api/revalidate, LEGAL_PATHS).
export const revalidate = 86400;
export const generateMetadata = () => legalMeta("data_retention");
export default async function Page() {
  return LegalPage({ purpose: "data_retention" }); // called, not rendered as a child: a page is the async component
}
