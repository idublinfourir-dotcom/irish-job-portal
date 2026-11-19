// No sign-in: the data request confirm link (decision #271, packages/db/src/data-request-confirm.ts). GET changes nothing; POST confirms once.
import { dataRequestGet, dataRequestPost } from "@portal/db";
import { portalOrigin } from "../../../lib/portal";

export const dynamic = "force-dynamic";
export const GET = (r: Request) => dataRequestGet(r, "portal");
export const POST = (r: Request) => dataRequestPost(r, "portal", portalOrigin());
