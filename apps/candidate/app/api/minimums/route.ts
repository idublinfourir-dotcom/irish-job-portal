import { minimumsRead } from "@portal/db";
import { cachedRead } from "../../../lib/api-cache";

// The pay and contract minimums in force today, with no occupation. Open to everyone, rate limited like the other public reads.
export const GET = (r: Request) => cachedRead(r, minimumsRead);
