import { statusGet, statusPost } from "../../../../lib/status";

// The company's status page (GET) and its owner's reply or appeal on a case (POST { action: "reply" | "appeal", caseId, text }).
export const GET = (request: Request) => statusGet(request);
export const POST = (request: Request) => statusPost(request);
