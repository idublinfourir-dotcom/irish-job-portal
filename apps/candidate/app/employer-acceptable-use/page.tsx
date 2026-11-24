// /employer-acceptable-use (P10, frame C22): the legal text of purpose employer_acceptable_use, through the shared layout in _content/legal.tsx.
import { LegalPage, legalMeta } from "../_content/legal";

export const generateMetadata = () => legalMeta("employer_acceptable_use");
export default async function Page() {
  return LegalPage({ purpose: "employer_acceptable_use" }); // called, not rendered as a child: a page is the async component
}
