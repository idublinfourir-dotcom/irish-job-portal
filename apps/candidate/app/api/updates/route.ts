import { updatesRead } from "@portal/db";
import { cachedRead } from "../../../lib/api-cache";

// The updates feed, newest first: ?after (the `next` of the page before). Open to everyone, rate limited like the other public reads.
export const GET = (r: Request) => cachedRead(r, updatesRead);
