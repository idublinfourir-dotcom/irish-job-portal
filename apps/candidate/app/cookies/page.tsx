// /cookies (P10, frame C22): the legal text of purpose cookie_policy, through the shared layout in _content/legal.tsx.
import { LegalPage, legalMeta } from "../_content/legal";

export const generateMetadata = () => legalMeta("cookie_policy");
export default async function Page() {
  return LegalPage({ purpose: "cookie_policy" }); // called, not rendered as a child: a page is the async component
}
