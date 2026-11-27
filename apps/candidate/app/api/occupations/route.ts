import { occupationsRead } from "@portal/db";
import { cachedRead } from "../../../lib/api-cache";

// Every occupation code with its title, address slug and list status, for the pickers. Open to everyone, rate limited like the other public reads.
export const GET = (r: Request) => cachedRead(r, occupationsRead);
