import { legalRead } from "@portal/db";
import { cachedRead } from "../../../lib/api-cache";

// R5: the legal text in force for ?purpose=signup_terms or privacy_notice (body, version, published date). 404 NOT_FOUND before any version.
export const GET = (r: Request) => cachedRead(r, legalRead);
