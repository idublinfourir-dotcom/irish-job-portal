import { helpListRead } from "@portal/db";
import { cachedRead } from "../../../../lib/api-cache";

// B19: every published help page: slug, title, category. Open to everyone, rate limited like the other public reads.
export const GET = (r: Request) => cachedRead(r, helpListRead);
