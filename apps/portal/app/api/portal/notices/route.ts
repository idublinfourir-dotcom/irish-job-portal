import { noticesGet, noticesPost } from "../../../../lib/notices";

// The signed-in user's notices (GET ?after=) and marking them read (POST { action: "read", id } or { action: "read_all" }).
export const GET = (request: Request) => noticesGet(request);
export const POST = (request: Request) => noticesPost(request);
