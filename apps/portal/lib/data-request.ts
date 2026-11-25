// The data request confirm link's reader for the page (P17c): the route's own GET handler (packages/db/src/data-request-confirm.ts, no sign-in), read through data.ts.
import { dataRequestGet } from "@portal/db";

export const dataRequestInfo = (r: Request) => dataRequestGet(r, "portal");
