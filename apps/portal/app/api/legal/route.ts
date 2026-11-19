// R5: no sign-in. The legal text in force for ?purpose=portal_signup_terms or privacy_notice (body, version, published date), rate limited per address.
import { portalLegalRead } from "@portal/db";

export const dynamic = "force-dynamic";
export const GET = (r: Request) => portalLegalRead(r);
