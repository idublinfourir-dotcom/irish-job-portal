import { guidesRead } from "@portal/db";
import { cachedRead } from "../cached";

// B15: every published guide by title: slug, title, checkedOn. Open to everyone, rate limited like the other public reads.
export const GET = (r: Request) => cachedRead(r, guidesRead);
