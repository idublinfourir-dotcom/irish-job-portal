import { floorGet, floorPost } from "../../../../lib/pay-floors";

// The company's pay floors (GET) and signing or withdrawing one (POST { action: "sign" | "withdraw", ... }).
export const GET = (request: Request) => floorGet(request);
export const POST = (request: Request) => floorPost(request);
