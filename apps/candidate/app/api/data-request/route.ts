// No sign-in: the data request confirm link (decision #271, packages/db/src/data-request-confirm.ts). GET changes nothing; POST confirms once.
import { candidateSettings } from "@portal/auth";
import { dataRequestGet, dataRequestPost } from "@portal/db";

export const dynamic = "force-dynamic";
export const GET = (r: Request) => dataRequestGet(r, "candidate");
export const POST = (r: Request) => dataRequestPost(r, "candidate", new URL(candidateSettings(process.env).baseURL).origin);
